package main

import (
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"testing"

	"github.com/dop251/goja"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
	"github.com/pocketbase/pocketbase/tools/security"
)

func runBootstrapIdentity(t *testing.T, app core.App, collection, email string) (map[string]string, error) {
	t.Helper()
	raw, err := os.ReadFile("pb_hooks/lib/bootstrap_identity.js")
	if err != nil {
		t.Fatal(err)
	}
	vm := goja.New()
	jsvm.BindCore(vm)
	jsvm.BindSecurity(vm)
	vm.Set("realApp", app)
	// Only opening the transaction is allowed through the outer app. Real PB
	// reads and writes must use the tx object passed to its callback.
	outer, err := vm.RunString(`({runInTransaction: (fn) => realApp.runInTransaction(fn),
		findCollectionByNameOrId() { throw new Error("outer app read") },
		findRecordsByFilter() { throw new Error("outer app read") },
		countRecords() { throw new Error("outer app read") }, save() { throw new Error("outer app write") }})`)
	if err != nil {
		t.Fatal(err)
	}
	vm.Set("$app", outer)
	value, err := vm.RunString("(function(){const module={exports:{}};\n" + string(raw) + "\nreturn module.exports.ensure})()")
	if err != nil {
		t.Fatal(err)
	}
	fn, ok := goja.AssertFunction(value)
	if !ok {
		t.Fatal("bootstrap helper missing")
	}
	result, err := fn(goja.Undefined(), outer, vm.ToValue(map[string]any{"collection": collection, "email": email, "password": "InitialBootstrap123!", "name": "Synthetic bootstrap"}))
	if err != nil {
		return nil, err
	}
	var exported map[string]string
	err = vm.ExportTo(result, &exported)
	return exported, err
}

func bootstrapBindingRecord(t *testing.T, app core.App, collection string) *core.Record {
	t.Helper()
	r, err := app.FindFirstRecordByFilter("bootstrap_bindings", "auth_collection = {:collection} && email_sha256 = {:hash}",
		dbx.Params{"collection": collection, "hash": security.SHA256("bootstrap@example.test")})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func bootstrapAccountState(t *testing.T, app core.App, r *core.Record) []byte {
	t.Helper()
	var row dbx.NullStringMap
	if err := app.DB().Select("*").From(r.Collection().Name).Where(dbx.HashExp{"id": r.Id}).One(&row); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(row)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestBootstrapBindingPreservesRenamedRotatedAndDemotedIdentity(t *testing.T) {
	for _, collection := range []string{"users", "_superusers"} {
		t.Run(collection, func(t *testing.T) {
			app := newSchemaTestApp(t)
			applyBootstrapBindingTestMigration(t, app)
			result, err := runBootstrapIdentity(t, app, collection, "  Bootstrap@Example.Test  ")
			if err != nil || result["status"] != "created" {
				t.Fatalf("first bootstrap: %v %v", result, err)
			}
			binding := bootstrapBindingRecord(t, app, collection)
			user, _ := app.FindRecordById(collection, binding.GetString("record_id"))
			user.SetEmail("renamed@example.test")
			user.SetPassword("RotatedBootstrap123!")
			user.SetVerified(false)
			if collection == "users" {
				user.Set("role", "user")
				user.Set("must_change_password", true)
			}
			if err := app.Save(user); err != nil {
				t.Fatal(err)
			}
			before := bootstrapAccountState(t, app, user)
			result, err = runBootstrapIdentity(t, app, collection, "bootstrap@example.test")
			if err != nil || result["status"] != "preserved" {
				t.Fatalf("repeat bootstrap: %v %v", result, err)
			}
			after, _ := app.FindRecordById(collection, user.Id)
			count, _ := app.CountRecords(collection)
			if count != 1 || !reflect.DeepEqual(before, bootstrapAccountState(t, app, after)) {
				t.Fatal("bootstrap recreated or modified the bound identity")
			}
		})
	}
}

func TestBootstrapBindingLegacyAdoptionAndAmbiguity(t *testing.T) {
	for _, collection := range []string{"users", "_superusers"} {
		t.Run(collection, func(t *testing.T) {
			app := newSchemaTestApp(t)
			applyBootstrapBindingTestMigration(t, app)
			c, _ := app.FindCollectionByNameOrId(collection)
			user := core.NewRecord(c)
			user.SetEmail("Bootstrap@Example.Test")
			user.SetPassword("LegacyPrivatePassword123!")
			if collection == "users" {
				user.Set("role", "user")
			}
			if err := app.Save(user); err != nil {
				t.Fatal(err)
			}
			before := bootstrapAccountState(t, app, user)
			result, err := runBootstrapIdentity(t, app, collection, "bootstrap@example.test")
			if err != nil || result["status"] != "bound" || bootstrapBindingRecord(t, app, collection).GetString("record_id") != user.Id {
				t.Fatalf("legacy adoption: %v %v", result, err)
			}
			after, _ := app.FindRecordById(collection, user.Id)
			if !reflect.DeepEqual(before, bootstrapAccountState(t, app, after)) {
				t.Fatal("legacy adoption changed account fields")
			}
			result, err = runBootstrapIdentity(t, app, collection, "unresolved@example.test")
			if err != nil || result["reason"] != "legacy_identity_unresolved" {
				t.Fatalf("ambiguous legacy identity was not refused: %v %v", result, err)
			}
			count, _ := app.CountRecords(collection)
			markers, _ := app.CountRecords("bootstrap_bindings")
			if count != 1 || markers != 1 {
				t.Fatal("legacy ambiguity created an account or marker")
			}
		})
	}
}

func TestBootstrapBindingRecreationRequiresDeletedIDAndUnoccupiedEmail(t *testing.T) {
	for _, collection := range []string{"users", "_superusers"} {
		for _, occupied := range []bool{false, true} {
			t.Run(collection+map[bool]string{false: "/free", true: "/occupied"}[occupied], func(t *testing.T) {
				app := newSchemaTestApp(t)
				// These records have no files. Avoid PocketBase's asynchronous file
				// cleanup racing the test's temporary directory cleanup.
				app.OnModelAfterDeleteSuccess().Unbind("__pbFilesManagerDelete__")
				applyBootstrapBindingTestMigration(t, app)
				if _, err := runBootstrapIdentity(t, app, collection, "bootstrap@example.test"); err != nil {
					t.Fatal(err)
				}
				binding := bootstrapBindingRecord(t, app, collection)
				originalID := binding.GetString("record_id")
				original, _ := app.FindRecordById(collection, originalID)
				c, _ := app.FindCollectionByNameOrId(collection)
				other := core.NewRecord(c)
				other.SetEmail("other@example.test")
				other.SetPassword("OtherIdentityPassword123!")
				if collection == "users" {
					other.Set("role", "user")
				}
				if err := app.Save(other); err != nil {
					t.Fatal(err)
				}
				if err := app.Delete(original); err != nil {
					t.Fatal(err)
				}
				if occupied {
					other.SetEmail("bootstrap@example.test")
					if err := app.Save(other); err != nil {
						t.Fatal(err)
					}
				}
				before := bootstrapAccountState(t, app, other)
				result, err := runBootstrapIdentity(t, app, collection, "bootstrap@example.test")
				if err != nil {
					t.Fatal(err)
				}
				count, _ := app.CountRecords(collection)
				currentBinding := bootstrapBindingRecord(t, app, collection)
				if occupied {
					if result["reason"] != "bound_identity_email_taken" || count != 1 || currentBinding.GetString("record_id") != originalID {
						t.Fatal("bootstrap adopted someone else's address")
					}
				} else if result["status"] != "created" || count != 2 || currentBinding.GetString("record_id") == originalID {
					t.Fatal("confirmed deletion did not recreate and rebind")
				}
				after, _ := app.FindRecordById(collection, other.Id)
				if !reflect.DeepEqual(before, bootstrapAccountState(t, app, after)) {
					t.Fatal("bootstrap modified another identity")
				}
			})
		}
	}
}

func TestBootstrapBindingPersistenceFailureRollsBackNewAccount(t *testing.T) {
	for _, collection := range []string{"users", "_superusers"} {
		t.Run(collection, func(t *testing.T) {
			app := newSchemaTestApp(t)
			applyBootstrapBindingTestMigration(t, app)
			app.OnRecordCreate("bootstrap_bindings").BindFunc(func(e *core.RecordEvent) error { return errors.New("synthetic binding failure") })
			if _, err := runBootstrapIdentity(t, app, collection, "bootstrap@example.test"); err == nil {
				t.Fatal("binding persistence failure was ignored")
			}
			count, _ := app.CountRecords(collection)
			markers, _ := app.CountRecords("bootstrap_bindings")
			if count != 0 || markers != 0 {
				t.Fatal("failed binding left a privileged orphan account")
			}
		})
	}
}

func TestBootstrapBindingQueryFailureDoesNotReplaceIdentity(t *testing.T) {
	app := newSchemaTestApp(t)
	applyBootstrapBindingTestMigration(t, app)
	if _, err := runBootstrapIdentity(t, app, "_superusers", "bootstrap@example.test"); err != nil {
		t.Fatal(err)
	}
	binding := bootstrapBindingRecord(t, app, "_superusers")
	if _, err := app.DB().NewQuery(`ALTER TABLE _superusers RENAME TO unavailable_superusers`).Execute(); err != nil {
		t.Fatal(err)
	}
	if _, err := runBootstrapIdentity(t, app, "_superusers", "bootstrap@example.test"); err == nil {
		t.Fatal("query failure treated as a missing identity")
	}
	if bootstrapBindingRecord(t, app, "_superusers").GetString("record_id") != binding.GetString("record_id") {
		t.Fatal("query failure rebound the identity")
	}
}
