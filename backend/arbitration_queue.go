package main

import (
	"net/http"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

// Only queue identities are returned. Material and independent results continue
// to use the existing manager-only arbitration endpoint.
func (s *importService) arbitrationQueue(e *core.RequestEvent) error {
	projectID := e.Request.PathValue("projectId")
	if _, _, err := s.requireProjectManager(e, projectID); err != nil {
		return err
	}
	query := e.Request.URL.Query()
	page, size := pageArgument(query.Get("page"), 1, 1000000), pageArgument(query.Get("perPage"), 25, 100)
	type item struct {
		ID         string `db:"id" json:"id"`
		PageNumber int    `db:"page_number" json:"page_number"`
	}
	var result map[string]any
	err := s.app.RunInTransaction(func(app core.App) error {
		params := dbx.Params{"project": projectID}
		where := " FROM pages WHERE project={:project} AND status='arbitration'"
		var count int
		if err := app.DB().NewQuery("SELECT COUNT(*)" + where).Bind(params).Row(&count); err != nil {
			return err
		}
		position := 0
		var previous, next *item
		if anchorID := query.Get("anchor"); anchorID != "" {
			anchor, err := app.FindRecordById("pages", anchorID)
			if err != nil || anchor.GetString("project") != projectID {
				return apis.NewNotFoundError("队列条目不存在或不属于当前项目", nil)
			}
			params["number"], params["anchor"] = anchor.GetInt("page_number"), anchor.Id
			before := " AND (page_number < {:number} OR (page_number = {:number} AND id < {:anchor}))"
			after := " AND (page_number > {:number} OR (page_number = {:number} AND id > {:anchor}))"
			if anchor.GetString("status") == "arbitration" {
				if err := app.DB().NewQuery("SELECT COUNT(*)" + where + before).Bind(params).Row(&position); err != nil {
					return err
				}
				position++
				if query.Get("page") == "" {
					page = (position-1)/size + 1
				}
			}
			for _, direction := range []struct {
				filter, order string
				target        **item
			}{{before, "page_number DESC,id DESC", &previous}, {after, "page_number,id", &next}} {
				rows := []item{}
				if err := app.DB().NewQuery("SELECT id,page_number" + where + direction.filter + " ORDER BY " + direction.order + " LIMIT 1").Bind(params).All(&rows); err != nil {
					return err
				}
				if len(rows) > 0 {
					*direction.target = &rows[0]
				}
			}
		}
		totalPages := max(1, (count+size-1)/size)
		page = min(page, totalPages)
		params["limit"], params["offset"] = size, (page-1)*size
		items := []item{}
		if err := app.DB().NewQuery("SELECT id,page_number" + where + " ORDER BY page_number,id LIMIT {:limit} OFFSET {:offset}").Bind(params).All(&items); err != nil {
			return err
		}
		result = map[string]any{"items": items, "page": page, "perPage": size, "totalItems": count, "totalPages": totalPages, "position": position, "previous": previous, "next": next}
		return nil
	})
	if err != nil {
		return err
	}
	return e.JSON(http.StatusOK, result)
}
