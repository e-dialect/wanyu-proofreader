package main

import (
	"errors"

	"github.com/pocketbase/pocketbase/core"
)

// JSVM deliberately excludes OnServe. Keep the startup transition in this
// narrow Go hook, after migrations and before HTTP accepts work. The DataDir
// ownership guard must run before Bootstrap opens any DB connection.
func registerAssistPublicationRecovery(app core.App) {
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		if err := recoverInterruptedAssistBulk(e.App); err != nil {
			return err
		}
		return e.Next()
	})
}

func recoverInterruptedAssistBulk(app core.App) error {
	owner, _ := app.Store().Get("fangjiDataDirectoryOwner").(bool)
	if !owner {
		return errors.New("assist startup recovery requires exclusive data-directory ownership")
	}
	return app.RunInTransaction(func(tx core.App) error {
		records, err := tx.FindRecordsByFilter("assist_publications", `state='staging' && (scope='rules' || scope='identity')`, "created,id", 2, 0)
		if err != nil {
			return err
		}
		if len(records) > 1 {
			return errors.New("assist bulk slot invariant violated")
		}
		for _, record := range records {
			record.Set("state", "aborted")
			record.Set("failure_code", "PROCESS_RESTARTED")
			if err := tx.Save(record); err != nil {
				return err
			}
		}
		return nil
	})
}
