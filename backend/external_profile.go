package main

import (
	"bytes"
	"context"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
	_ "golang.org/x/image/webp"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"net/mail"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

type externalProfile struct{ Name, Email, AvatarURL string }
type externalProfileProvider interface {
	Profile(context.Context, string) externalProfile
	Avatar(context.Context, string) *filesystem.File
}

// Import only empty local fields, after authenticating and resolving the stable
// provider/subject mapping. A remote email never selects or links local accounts.
func (s *externalIdentityService) syncExternalProfile(ctx context.Context, provider externalIdentityProvider, subject string, user *core.Record, newlyCreated ...bool) *core.Record {
	source, ok := provider.(externalProfileProvider)
	if !ok {
		return user
	}
	if user.GetString("name") != "" && user.Email() != "" && user.GetString("avatar") != "" {
		return user
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	profile := source.Profile(ctx, subject)
	var avatar *filesystem.File
	if user.GetString("avatar") == "" && profile.AvatarURL != "" {
		avatar = source.Avatar(ctx, profile.AvatarURL)
	}
	// Each field is independent: e.g. a duplicate email must not discard a nickname.
	for _, field := range []string{"name", "email", "avatar"} {
		err := s.app.RunInTransaction(func(tx core.App) error {
			current, err := tx.FindRecordById("users", user.Id)
			if err != nil {
				return err
			}
			// Replace the seed only during creation, never a later local nickname edit.
			seedNickname := field == "name" && len(newlyCreated) > 0 && newlyCreated[0] && current.GetString("name") == current.GetString("username")
			if current.GetString(field) != "" && !seedNickname {
				return nil
			}
			switch field {
			case "name":
				name := strings.TrimSpace(profile.Name)
				if name == "" || !utf8.ValidString(name) || utf8.RuneCountInString(name) > 255 {
					return nil
				}
				name, err = availableNickname(tx, name, current.GetString("username"), current.Id)
				if err != nil {
					return err
				}
				current.Set("name", name)
			case "email":
				email := strings.TrimSpace(profile.Email)
				parsed, err := mail.ParseAddress(email)
				if err != nil || parsed.Address != email || len(email) > 255 {
					return nil
				}
				current.SetEmail(email)
				current.SetVerified(false)
			case "avatar":
				if avatar == nil {
					return nil
				}
				current.Set("avatar", avatar)
			}
			return tx.Save(current)
		})
		if err != nil {
			s.logAuthResult(provider.ID(), "profile_"+field+"_skipped")
		}
	}
	if current, err := s.app.FindRecordById("users", user.Id); err == nil {
		return current
	}
	return user
}

// Copy trusted provider storage images locally; no external tracking URLs in the
// browser and no arbitrary server-side URL fetches or redirects.
func safeHinghwaAvatarURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.Fragment != "" {
		return false
	}
	switch u.Hostname() {
	case "cos.edialect.top", "cos.test.edialect.top", "api.pxm.edialect.top", "dummyimage.com":
		return true
	}
	return false
}
func (p *hinghwaIdentityProvider) Avatar(ctx context.Context, raw string) *filesystem.File {
	if !safeHinghwaAvatarURL(raw) {
		return nil
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil
	}
	response, err := p.client.Do(request)
	if err != nil {
		return nil
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil
	}
	const maxBytes = 2 * 1024 * 1024
	data, err := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
	if err != nil || len(data) > maxBytes {
		return nil
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width <= 0 || config.Height <= 0 || config.Width > 4096 || config.Height > 4096 {
		return nil
	}
	switch format {
	case "png", "jpeg", "gif", "webp":
	default:
		return nil
	}
	file, err := filesystem.NewFileFromBytes(data, "hinghwa-avatar."+format)
	if err != nil {
		return nil
	}
	return file
}
