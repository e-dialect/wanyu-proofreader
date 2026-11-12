package main

import (
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

func TestProjectPurposeMigrationPreservesPracticeIdentity(t *testing.T) {
	app := newInitialSchemaTestApp(t)
	up, down := deliveryMigration(t, "pb_migrations/1794442500_project_purpose.js")
	if err := up(app); err != nil {
		t.Fatal(err)
	}
	if err := down(app); err != nil {
		t.Fatal(err)
	}
	if err := up(app); err != nil {
		t.Fatal(err)
	}
	users, _ := app.FindCollectionByNameOrId("users")
	user := core.NewRecord(users)
	user.SetEmail("synthetic-practice@example.com")
	user.Set("role", "user")
	user.SetPassword("SyntheticPractice123!")
	if err := app.Save(user); err != nil {
		t.Fatal(err)
	}
	projects, _ := app.FindCollectionByNameOrId("projects")
	project := core.NewRecord(projects)
	project.Set("name", "Synthetic practice")
	project.Set("admin", user.Id)
	project.Set("access_mode", "members_only")
	project.Set("purpose", "practice")
	project.Set("required_proofreads", 2)
	if err := app.Save(project); err != nil {
		t.Fatal(err)
	}
	if err := down(app); err == nil || !strings.Contains(err.Error(), "practice projects exist") {
		t.Fatalf("down must retain practice identity, got %v", err)
	}
	retained, err := app.FindRecordById("projects", project.Id)
	if err != nil || retained.GetString("purpose") != "practice" {
		t.Fatalf("practice identity lost: %v", err)
	}
}
