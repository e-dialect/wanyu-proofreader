package main

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
)

// Temporary nullable tables include legacy/LEFT-JOIN edge values that the
// current collection schema normally excludes. Compare all aggregate fields,
// not only claimable, against the frozen original classifier and join shape.
func TestQueueAggregationNullableClassificationOracle(t *testing.T) {
	app := newSchemaTestApp(t)
	tx, err := app.ConcurrentDB().(*dbx.DB).Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	for _, query := range []string{
		`CREATE TEMP TABLE projects(id TEXT,name TEXT,description TEXT,admin TEXT,required_proofreads INTEGER,purpose TEXT)`,
		`CREATE TEMP TABLE project_memberships(project TEXT,user TEXT,role TEXT)`,
		`CREATE TEMP TABLE pages(id TEXT,project TEXT,page_number INTEGER,pdf_page INTEGER,status TEXT,difficulty_tier TEXT,missing_glyph INTEGER,proofreader TEXT,proofread_round INTEGER)`,
		`CREATE TEMP TABLE task_leases(id TEXT,page TEXT,expires_at TEXT)`,
		`CREATE TEMP TABLE proofreading_attempts(page TEXT,project TEXT,round INTEGER,kind TEXT,proofreader TEXT)`,
		`CREATE INDEX temp.idx_nullable_attempts ON proofreading_attempts(page,round,kind,proofreader)`,
		`INSERT INTO projects(id,name,description,admin,required_proofreads) VALUES('filled','Same name','nullable legacy metadata','owner',2),('nullquorum','Same name','null quorum','owner',NULL),('empty','Same name','no pages','owner',2),('foreign','Foreign','not authorized','owner',2)`,
		`INSERT INTO project_memberships VALUES('filled','reader','proofreader'),('nullquorum','reader','proofreader'),('empty','reader','proofreader')`,
	} {
		if _, err := tx.NewQuery(query).Execute(); err != nil {
			t.Fatal(err)
		}
	}
	number := 0
	for _, status := range []any{"pending", "proofread", "claimed", "proofreading", "approved", "arbitration", "importing", "", nil} {
		for _, holder := range []any{"reader", "other", "", nil} {
			for lease := 0; lease < 4; lease++ {
				for attempt := 0; attempt < 4; attempt++ {
					number++
					id := fmt.Sprintf("nullable%07d", number)
					project := "filled"
					if number%2 == 0 {
						project = "nullquorum"
					}
					var round any = 1
					if number%3 == 0 {
						round = 0
					}
					if number%5 == 0 {
						round = nil
					}
					var tier any = "A"
					if number%3 == 0 {
						tier = ""
					}
					if number%7 == 0 {
						tier = nil
					}
					var glyph any = number % 2
					if number%5 == 0 {
						glyph = nil
					}
					p := dbx.Params{"id": id, "project": project, "number": number, "status": status, "holder": holder, "round": round, "tier": tier, "glyph": glyph}
					if _, err := tx.NewQuery(`INSERT INTO pages VALUES({:id},{:project},{:number},{:number},{:status},{:tier},{:glyph},{:holder},{:round})`).Bind(p).Execute(); err != nil {
						t.Fatal(err)
					}
					if lease > 0 {
						var expires any = "2030-01-01 00:00:00.000Z"
						if lease == 2 {
							expires = "2020-01-01 00:00:00.000Z"
						}
						if lease == 3 {
							expires = nil
						}
						if _, err := tx.NewQuery(`INSERT INTO task_leases VALUES({:id},{:id},{:expires})`).Bind(dbx.Params{"id": id, "expires": expires}).Execute(); err != nil {
							t.Fatal(err)
						}
					}
					if attempt > 0 {
						actor, attemptRound := "reader", 1
						if attempt == 2 {
							attemptRound = 2
						}
						if attempt == 3 {
							actor = "other"
						}
						if _, err := tx.NewQuery(`INSERT INTO proofreading_attempts VALUES({:id},{:project},{:round},'proofread',{:actor})`).Bind(dbx.Params{"id": id, "project": project, "round": attemptRound, "actor": actor}).Execute(); err != nil {
							t.Fatal(err)
						}
					}
				}
			}
		}
	}
	for _, user := range []string{"reader", "outsider"} {
		params := dbx.Params{"user": user, "now": "2026-11-09 00:00:00.000Z"}
		var before, after []dbx.NullStringMap
		if err := tx.NewQuery(legacyQueueCTE + `SELECT * FROM queues ORDER BY id`).Bind(params).All(&before); err != nil {
			t.Fatal(err)
		}
		if err := tx.NewQuery(queueCTE + `SELECT * FROM queues ORDER BY id`).Bind(params).All(&after); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(before, after) {
			t.Fatalf("nullable aggregation changed for %s: old=%v new=%v", user, before, after)
		}
	}
	var plan []struct {
		Detail string `db:"detail"`
	}
	if err := tx.NewQuery("EXPLAIN QUERY PLAN " + queuePageSQL("1=1")).Bind(dbx.Params{
		"user": "reader", "now": "2026-11-09 00:00:00.000Z", "page": 1, "size": 12,
	}).All(&plan); err != nil {
		t.Fatal(err)
	}
	correlated, classified := 0, 0
	for _, step := range plan {
		if strings.Contains(step.Detail, "CORRELATED SCALAR SUBQUERY") {
			correlated++
		}
		if step.Detail == "MATERIALIZE classified" {
			classified++
		}
	}
	// A flattened classifier repeated both attempt probes eight times in the
	// measured rejected plan. Keep one pair and one candidate materialization.
	if correlated != 2 || classified != 1 {
		t.Fatalf("candidate checks duplicated or materialization changed: %v", plan)
	}
}
