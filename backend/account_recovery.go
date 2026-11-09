package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"unicode/utf8"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/spf13/cobra"
)

// The operator must stop the serving process before invoking this maintenance
// command. No password arguments/environment variables, account creation,
// email change or role elevation are accepted.
func registerAccountRecoveryCommand(app *pocketbase.PocketBase) {
	var collection, id, operator string
	var stdin bool
	cmd := &cobra.Command{Use: "recover-account", Short: "Reset an existing account during offline maintenance (password via stdin)", Args: func(_ *cobra.Command, args []string) error {
		if len(args) > 0 {
			return errors.New("no positional arguments accepted; use --password-stdin")
		}
		return nil
	}, RunE: func(cmd *cobra.Command, args []string) error {
		if !stdin {
			return errors.New("--password-stdin is required; never pass a password as an argument")
		}
		if collection != "users" && collection != "_superusers" {
			return errors.New("collection must be users or _superusers")
		}
		if id == "" || strings.TrimSpace(operator) == "" || len(operator) > 80 {
			return errors.New("an exact record --id and non-secret --operator label (max 80 bytes) are required")
		}
		password, err := readRecoveryPassword(cmd.InOrStdin())
		if err != nil {
			return err
		}
		err = recoverAccount(app, collection, id, operator, password)
		password = ""
		if err != nil {
			return errors.New("account recovery failed; verify the record id and database/migration state")
		}
		_, err = fmt.Fprintln(cmd.OutOrStdout(), "Account recovered; existing sessions revoked. No role or email changed.")
		return err
	}}
	cmd.Flags().StringVar(&collection, "collection", "users", "users or _superusers")
	cmd.Flags().StringVar(&id, "id", "", "Exact existing record id")
	cmd.Flags().StringVar(&operator, "operator", "", "Non-secret operator label for audit")
	cmd.Flags().BoolVar(&stdin, "password-stdin", false, "Read one password line from stdin")
	app.RootCmd.AddCommand(cmd)
	if selected, _, err := app.RootCmd.Find(os.Args[1:]); err == nil && selected == cmd {
		app.Store().Set("accountRecoveryCLI", true)
	}
}
func readRecoveryPassword(reader io.Reader) (string, error) {
	data, err := bufio.NewReader(io.LimitReader(reader, 4097)).ReadString('\n')
	if err != nil && err != io.EOF {
		return "", errors.New("cannot read password input")
	}
	password := strings.TrimSuffix(strings.TrimSuffix(data, "\n"), "\r")
	if !utf8.ValidString(password) || utf8.RuneCountInString(password) < 12 || utf8.RuneCountInString(password) > 71 || len(password) > 72 {
		return "", errors.New("password must contain 12–71 characters and at most 72 UTF-8 bytes")
	}
	return password, nil
}
func recoverAccount(app core.App, collection, id, operator, password string) error {
	return app.RunInTransaction(func(tx core.App) error {
		record, err := tx.FindRecordById(collection, id)
		if err != nil {
			return err
		}
		record.SetPassword(password)
		record.RefreshTokenKey()
		if collection == "users" {
			record.Set("must_change_password", true)
		}
		if err := tx.Save(record); err != nil {
			return err
		}
		return appendSecurityEvent(tx, nil, "account.admin_recovered", "success", "", record.Id, "", map[string]any{"operator": operator, "collection": collection})
	})
}
