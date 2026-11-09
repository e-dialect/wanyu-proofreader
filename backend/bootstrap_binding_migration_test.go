package main

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/dop251/goja"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

func bootstrapBindingTestMigration(t testing.TB) (func(core.App) error, func(core.App) error) {
	t.Helper()
	raw, err := os.ReadFile("pb_migrations/1794204500_bootstrap_bindings.js")
	if err != nil {
		t.Fatal(err)
	}
	vm := goja.New()
	jsvm.BindCore(vm)
	var up, down func(core.App) error
	vm.Set("migrate", func(apply, revert func(core.App) error) { up, down = apply, revert })
	if _, err := vm.RunString(string(raw)); err != nil {
		t.Fatal(err)
	}
	if up == nil || down == nil {
		t.Fatal("bootstrap binding migration must define both directions")
	}
	return up, down
}

func applyBootstrapBindingTestMigration(t testing.TB, app core.App) {
	t.Helper()
	up, _ := bootstrapBindingTestMigration(t)
	if err := app.RunInTransaction(up); err != nil {
		t.Fatal(err)
	}
}

func bootstrapAuthRowSnapshot(t testing.TB, app core.App) map[string][]byte {
	t.Helper()
	result := map[string][]byte{}
	for _, name := range []string{"users", "_superusers"} {
		var rows []dbx.NullStringMap
		if err := app.DB().Select("*").From(name).OrderBy("id").All(&rows); err != nil {
			t.Fatal(err)
		}
		raw, err := json.Marshal(rows)
		if err != nil {
			t.Fatal(err)
		}
		result[name] = raw
	}
	return result
}

func TestBootstrapBindingMigrationPreservesLegacyAuthRowsAndEmptyRoundTrip(t *testing.T) {
	// This imports the original schema, not a hand-built account table. Existing
	// credential hashes/token keys are compared in memory and never printed.
	app := newInitialSchemaTestApp(t)
	for _, name := range []string{"users", "_superusers"} {
		collection, err := app.FindCollectionByNameOrId(name)
		if err != nil {
			t.Fatal(err)
		}
		record := core.NewRecord(collection)
		record.SetEmail("legacy-" + strings.TrimPrefix(name, "_") + "@example.test")
		record.SetPassword("ExistingSyntheticPassword123!")
		record.SetVerified(false)
		if name == "users" {
			record.Set("username", "renamed_bootstrap_owner")
			record.Set("name", "Existing synthetic account")
			record.Set("role", "user")
			record.Set("must_change_password", true)
		}
		if err := app.Save(record); err != nil {
			t.Fatal(err)
		}
	}
	before := bootstrapAuthRowSnapshot(t, app)
	up, down := bootstrapBindingTestMigration(t)
	for _, operation := range []struct {
		name string
		run  func(core.App) error
	}{{"up", up}, {"down", down}, {"up_again", up}} {
		if err := app.RunInTransaction(operation.run); err != nil {
			t.Fatalf("%s: %v", operation.name, err)
		}
		for name, current := range bootstrapAuthRowSnapshot(t, app) {
			if !bytes.Equal(current, before[name]) {
				t.Fatalf("%s changed existing %s account attributes", operation.name, name)
			}
		}
		collection, err := app.FindCollectionByNameOrId("bootstrap_bindings")
		if operation.name == "down" {
			if err == nil {
				t.Fatal("empty binding collection survived down")
			}
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		if collection.ListRule != nil || collection.ViewRule != nil || collection.CreateRule != nil || collection.UpdateRule != nil || collection.DeleteRule != nil {
			t.Fatal("bootstrap binding native API rules must all be null")
		}
		field, ok := collection.Fields.GetByName("record_id").(*core.TextField)
		if !ok || !field.Required || field.Max != 40 {
			t.Fatal("bootstrap record id must remain required text without a foreign key")
		}
		digest, ok := collection.Fields.GetByName("email_sha256").(*core.TextField)
		if !ok || !digest.Required || digest.Min != 64 || digest.Max != 64 || digest.Pattern != "^[a-f0-9]{64}$" {
			t.Fatal("bootstrap email hash must be exactly 64 lowercase hexadecimal characters")
		}
		if count, err := app.CountRecords("bootstrap_bindings"); err != nil || count != 0 {
			t.Fatal("schema migration must not infer legacy identity bindings")
		}
	}
}

func TestBootstrapBindingMigrationUniqueIdentityAndPopulatedDownRefusal(t *testing.T) {
	app := newSchemaTestApp(t)
	applyBootstrapBindingTestMigration(t, app)
	_, down := bootstrapBindingTestMigration(t)
	users, _ := app.FindCollectionByNameOrId("users")
	user := core.NewRecord(users)
	user.SetEmail("bound-synthetic@example.test")
	user.SetPassword("SyntheticBoundPassword123!")
	user.Set("role", "user")
	if err := app.Save(user); err != nil {
		t.Fatal(err)
	}
	bindings, _ := app.FindCollectionByNameOrId("bootstrap_bindings")
	makeBinding := func(collection string) *core.Record {
		record := core.NewRecord(bindings)
		record.Set("auth_collection", collection)
		record.Set("email_sha256", strings.Repeat("a", 64))
		record.Set("record_id", user.Id)
		return record
	}
	bound := makeBinding("users")
	if err := app.Save(bound); err != nil {
		t.Fatal(err)
	}
	if err := app.Save(makeBinding("users")); err == nil {
		t.Fatal("duplicate collection/email binding was accepted")
	}
	if err := app.Save(makeBinding("_superusers")); err != nil {
		t.Fatal("same email hash must be independent across auth collections")
	}
	if err := app.Delete(user); err != nil {
		t.Fatal(err)
	}
	if current, err := app.FindRecordById("bootstrap_bindings", bound.Id); err != nil || current.GetString("record_id") != user.Id {
		t.Fatal("deleting an account must preserve its bootstrap identity anchor")
	}
	if err := app.RunInTransaction(down); err == nil {
		t.Fatal("populated bootstrap bindings must refuse down")
	}
	if count, err := app.CountRecords("bootstrap_bindings"); err != nil || count != 2 {
		t.Fatal("refused down changed persisted bindings")
	}
}

func TestBootstrapBindingDownFailsClosedWhenCountCannotBeRead(t *testing.T) {
	app := newSchemaTestApp(t)
	applyBootstrapBindingTestMigration(t, app)
	_, down := bootstrapBindingTestMigration(t)
	if _, err := app.DB().NewQuery("ALTER TABLE bootstrap_bindings RENAME TO unavailable_bootstrap_bindings").Execute(); err != nil {
		t.Fatal(err)
	}
	if err := app.RunInTransaction(down); err == nil {
		t.Fatal("failed binding count must not be treated as an empty collection")
	}
	var count int
	if err := app.DB().NewQuery("SELECT COUNT(*) FROM _collections WHERE name='bootstrap_bindings'").Row(&count); err != nil || count != 1 {
		t.Fatal("count failure removed the collection identity")
	}
}
