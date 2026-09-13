package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"

	"github.com/pocketbase/pocketbase/tools/security"
)

const (
	externalCredentialBodyLimit = 16 * 1024
	externalAttemptLimit        = 10
	externalGlobalAttemptLimit  = 3000
	externalAttemptWindow       = 5 * time.Minute
	externalAttemptMaxClients   = 10000
)

var (
	errExternalCredentials = errors.New("external identity credentials rejected")
	errExternalUnavailable = errors.New("external identity provider unavailable")
	errIdentityOwned       = errors.New("external identity is already bound to another user")
	errProviderBound       = errors.New("user already has an identity for this provider")
)

// externalIdentityProvider deliberately exposes only the provider-local stable
// subject. Remote tokens never cross this boundary; an optional public profile
// is read separately after authentication to fill missing local fields.
type externalIdentityProvider interface {
	ID() string
	Name() string
	Authenticate(ctx context.Context, identity, password string) (subject string, err error)
}

type externalIdentityService struct {
	app       core.App
	providers map[string]externalIdentityProvider
	limiter   *externalAttemptLimiter
	global    *externalAttemptLimiter
}

func newExternalIdentityService(app core.App, providers ...externalIdentityProvider) *externalIdentityService {
	registry := make(map[string]externalIdentityProvider, len(providers))
	for _, provider := range providers {
		if provider == nil || provider.ID() == "" {
			continue
		}
		registry[provider.ID()] = provider
	}
	return &externalIdentityService{
		app:       app,
		providers: registry,
		limiter:   newExternalAttemptLimiter(externalAttemptLimit, externalAttemptWindow),
		global:    newExternalAttemptLimiter(externalGlobalAttemptLimit, externalAttemptWindow),
	}
}

func (s *externalIdentityService) register() {
	s.app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.GET("/api/fangji/auth/providers", s.listProviders)
		e.Router.POST(
			"/api/fangji/auth/external/{provider}/login",
			s.login).Bind(apis.BodyLimit(externalCredentialBodyLimit))
		e.Router.POST(
			"/api/fangji/auth/external/{provider}/bind",
			s.bind).Bind(apis.BodyLimit(externalCredentialBodyLimit),
			apis.RequireAuth("users"))
		return e.Next()
	})
}

type externalProviderView struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Bound bool   `json:"bound"`
}

func (s *externalIdentityService) listProviders(c *core.RequestEvent) error {
	auth := c.Auth
	views := make([]externalProviderView, 0, len(s.providers))
	for _, provider := range s.providers {
		view := externalProviderView{ID: provider.ID(), Name: provider.Name()}
		if auth != nil {
			view.Bound = s.userHasProvider(auth.Id, provider.ID())
		}
		views = append(views, view)
	}
	sort.Slice(views, func(i, j int) bool { return views[i].ID < views[j].ID })
	return c.JSON(http.StatusOK, map[string]any{"providers": views})
}

func (s *externalIdentityService) login(c *core.RequestEvent) error {
	provider, subject, err := s.authenticateRequest(c)
	if err != nil {
		return err
	}

	user, created, err := s.resolveOrCreateUser(provider.ID(), subject)
	if err != nil {
		s.logAuthResult(provider.ID(), "mapping_error")
		return apis.NewApiError(http.StatusInternalServerError, "外部账号登录暂时不可用，请稍后重试。", nil)
	}

	user = s.syncExternalProfile(c.Request.Context(), provider, subject, user)
	s.logAuthResult(provider.ID(), "success")
	return apis.RecordAuthResponse(c, user, "external", map[string]any{
		"provider": provider.ID(),
		"created":  created,
	})
}

func (s *externalIdentityService) bind(c *core.RequestEvent) error {
	auth := c.Auth
	if auth == nil {
		return apis.NewUnauthorizedError("登录状态已失效，请重新登录。", nil)
	}
	if auth.GetBool("must_change_password") {
		return apis.NewForbiddenError("请先完成初始密码修改，再绑定外部账号。", nil)
	}

	provider, subject, err := s.authenticateRequest(c)
	if err != nil {
		return err
	}
	created, err := s.bindIdentity(auth.Id, provider.ID(), subject)
	if errors.Is(err, errIdentityOwned) {
		return apis.NewApiError(http.StatusConflict, "该外部账号已绑定其他万语校坊账号。", nil)
	}
	if errors.Is(err, errProviderBound) {
		return apis.NewApiError(http.StatusConflict, "当前万语校坊账号已绑定此身份来源的其他账号。", nil)
	}
	if err != nil {
		s.logAuthResult(provider.ID(), "binding_error")
		return apis.NewApiError(http.StatusInternalServerError, "暂时无法绑定外部账号，请稍后重试。", nil)
	}

	user := s.syncExternalProfile(c.Request.Context(), provider, subject, auth)
	user.IgnoreEmailVisibility(true)
	token, err := user.NewAuthToken()
	if err != nil {
		return err
	}
	s.logAuthResult(provider.ID(), "bound")
	return c.JSON(http.StatusOK, map[string]any{
		"provider": provider.ID(),
		"bound":    true,
		"created":  created,
		"record":   user,
		"token":    token,
	})
}

func (s *externalIdentityService) authenticateRequest(c *core.RequestEvent) (externalIdentityProvider, string, error) {
	providerID := strings.TrimSpace(c.Request.PathValue("provider"))
	provider, ok := s.providers[providerID]
	if !ok {
		return nil, "", apis.NewNotFoundError("该外部身份来源未启用。", nil)
	}

	info, err := c.RequestInfo()
	if err != nil {
		return nil, "", err
	}
	data := info.Body
	identity := strings.TrimSpace(stringValue(data["identity"]))
	password := stringValue(data["password"])
	if identity == "" || len(identity) > 200 || password == "" || len(password) > 1024 {
		return nil, "", apis.NewBadRequestError("请输入有效的外部账号和密码。", nil)
	}
	if !s.allowAttempt(providerID, c.Get("fangjiClientIP").(string)) {
		s.logAuthResult(providerID, "rate_limited")
		return nil, "", apis.NewApiError(http.StatusTooManyRequests, "登录尝试过于频繁，请稍后再试。", nil)
	}

	subject, err := provider.Authenticate(c.Request.Context(), identity, password)
	if errors.Is(err, errExternalCredentials) {
		s.logAuthResult(providerID, "rejected")
		return nil, "", apis.NewUnauthorizedError("外部账号或密码不正确。", nil)
	}
	if err != nil || strings.TrimSpace(subject) == "" || len(subject) > 255 {
		s.logAuthResult(providerID, "unavailable")
		return nil, "", apis.NewApiError(http.StatusBadGateway, "外部身份服务暂时不可用，请稍后重试。", nil)
	}
	return provider, strings.TrimSpace(subject), nil
}

func (s *externalIdentityService) allowAttempt(providerID, clientIP string) bool {
	if !s.limiter.Allow(externalLimitKey("client:"+providerID, clientIP)) {
		return false
	}
	return s.global.Allow(externalLimitKey("global", providerID))
}

func stringValue(value any) string {
	text, _ := value.(string)
	return text
}

func (s *externalIdentityService) resolveOrCreateUser(provider, subject string) (*core.Record, bool, error) {
	return s.resolveOrCreateUserWithName(provider, subject, "")
}

func (s *externalIdentityService) resolveOrCreateUserWithName(provider, subject, name string) (*core.Record, bool, error) {
	if user, err := findMappedUser(s.app, provider, subject); err == nil {
		return user, false, nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, false, err
	}

	var user *core.Record
	created := false
	err := s.app.RunInTransaction(func(txDao core.App) error {
		mapped, err := findMappedUser(txDao, provider, subject)
		if err == nil {
			user = mapped
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		users, err := txDao.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}
		mappings, err := txDao.FindCollectionByNameOrId("external_identity_mappings")
		if err != nil {
			return err
		}

		username := availableExternalUsername(txDao, users.Id, provider, subject)
		user = core.NewRecord(users)
		user.Set("username", username)
		user.Set("name", name)
		user.Set("role", "user")
		user.Set("must_change_password", false)
		user.SetPassword(security.RandomString(64))
		user.SetVerified(true)
		if err := txDao.Save(user); err != nil {
			return err
		}

		mapping := core.NewRecord(mappings)
		mapping.Set("user", user.Id)
		mapping.Set("provider", provider)
		mapping.Set("subject", subject)
		if err := txDao.Save(mapping); err != nil {
			return err
		}
		created = true
		return nil
	})
	if err != nil {
		// A concurrent first login may win the unique mapping race after our
		// transaction started. Reuse that committed mapping instead of surfacing a
		// transient failure or creating a second local account.
		if mapped, lookupErr := findMappedUser(s.app, provider, subject); lookupErr == nil {
			return mapped, false, nil
		}
	}
	return user, created, err
}

func (s *externalIdentityService) bindIdentity(userID, provider, subject string) (bool, error) {
	created := false
	err := s.app.RunInTransaction(func(txDao core.App) error {
		mapping, err := findIdentityMapping(txDao, provider, subject)
		if err == nil {
			if mapping.GetString("user") == userID {
				return nil
			}
			return errIdentityOwned
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		_, err = findUserProviderMapping(txDao, userID, provider)
		if err == nil {
			return errProviderBound
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		collection, err := txDao.FindCollectionByNameOrId("external_identity_mappings")
		if err != nil {
			return err
		}
		mapping = core.NewRecord(collection)
		mapping.Set("user", userID)
		mapping.Set("provider", provider)
		mapping.Set("subject", subject)
		if err := txDao.Save(mapping); err != nil {
			return err
		}
		created = true
		return nil
	})
	if err != nil {
		if mapping, lookupErr := findIdentityMapping(s.app, provider, subject); lookupErr == nil {
			if mapping.GetString("user") == userID {
				return false, nil
			}
			return false, errIdentityOwned
		}
		if _, lookupErr := findUserProviderMapping(s.app, userID, provider); lookupErr == nil {
			return false, errProviderBound
		}
	}
	return created, err
}

func (s *externalIdentityService) userHasProvider(userID, provider string) bool {
	_, err := s.app.FindFirstRecordByFilter(
		"external_identity_mappings",
		"user = {:user} && provider = {:provider}",
		dbx.Params{"user": userID, "provider": provider},
	)
	return err == nil
}

func findMappedUser(dao core.App, provider, subject string) (*core.Record, error) {
	mapping, err := findIdentityMapping(dao, provider, subject)
	if err != nil {
		return nil, err
	}
	return dao.FindRecordById("users", mapping.GetString("user"))
}

func findIdentityMapping(dao core.App, provider, subject string) (*core.Record, error) {
	return dao.FindFirstRecordByFilter(
		"external_identity_mappings",
		"provider = {:provider} && subject = {:subject}",
		dbx.Params{"provider": provider, "subject": subject},
	)
}

func findUserProviderMapping(dao core.App, userID, provider string) (*core.Record, error) {
	return dao.FindFirstRecordByFilter(
		"external_identity_mappings",
		"user = {:user} && provider = {:provider}",
		dbx.Params{"user": userID, "provider": provider},
	)
}

func availableExternalUsername(dao core.App, usersCollectionID, provider, subject string) string {
	hash := sha256.Sum256([]byte(provider + "\x00" + subject))
	base := fmt.Sprintf("ext_%s_%s", provider, hex.EncodeToString(hash[:12]))
	if usernameAvailable(dao, usersCollectionID, base) {
		return base
	}
	for {
		candidate := base + "_" + strings.ToLower(security.RandomString(8))
		if usernameAvailable(dao, usersCollectionID, candidate) {
			return candidate
		}
	}
}

func (s *externalIdentityService) logAuthResult(provider, outcome string) {
	// Never include the submitted identity, password, remote response or subject.
	s.app.Logger().Info("external identity request", slog.String("provider", provider), slog.String("outcome", outcome))
}

type externalAttempt struct {
	count   int
	resetAt time.Time
}

type externalAttemptLimiter struct {
	mu      sync.Mutex
	entries map[string]externalAttempt
	limit   int
	window  time.Duration
	now     func() time.Time
}

func newExternalAttemptLimiter(limit int, window time.Duration) *externalAttemptLimiter {
	return &externalAttemptLimiter{
		entries: map[string]externalAttempt{},
		limit:   limit,
		window:  window,
		now:     time.Now,
	}
}

func (l *externalAttemptLimiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	entry, exists := l.entries[key]
	if !exists && len(l.entries) >= externalAttemptMaxClients {
		var oldestKey string
		var oldestReset time.Time
		for candidateKey, candidate := range l.entries {
			if !now.Before(candidate.resetAt) {
				delete(l.entries, candidateKey)
				continue
			}
			if oldestKey == "" || candidate.resetAt.Before(oldestReset) {
				oldestKey = candidateKey
				oldestReset = candidate.resetAt
			}
		}
		if len(l.entries) >= externalAttemptMaxClients && oldestKey != "" {
			delete(l.entries, oldestKey)
		}
	}
	if !exists || !now.Before(entry.resetAt) {
		l.entries[key] = externalAttempt{count: 1, resetAt: now.Add(l.window)}
		return true
	}
	if entry.count >= l.limit {
		return false
	}
	entry.count++
	l.entries[key] = entry
	return true
}

func externalLimitKey(provider, ip string) string {
	hash := sha256.Sum256([]byte(provider + "\x00" + ip))
	return hex.EncodeToString(hash[:])
}

func usernameAvailable(app core.App, collectionID, username string) bool {
	_, err := app.FindFirstRecordByFilter(collectionID, "username = {:username}", dbx.Params{"username": username})
	return errors.Is(err, sql.ErrNoRows)
}
