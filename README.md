# ClickUp TODO

A VS Code extension that keeps a `TODO.md` file and your ClickUp lists in sync, both ways.

The task list is plain Markdown, so you, your editor and an AI coding agent (Claude Code, Copilot, …) can all read it and add to it. Your team keeps working in ClickUp. The sidebar shows the same tasks as cards.

## Features

- **Two-way sync:** every list in your ClickUp workspace gets a `## List name` heading in `TODO.md`. New tasks, renames, description edits and ticks go both ways.
- **Sidebar cards:** a list switcher, search, a "New task" form, and cards you can expand, edit and tick in place.
- **Review flow:** ticking a task moves it to `in review` (configurable) instead of closing it. Someone reviews it and sets it to complete in ClickUp, and it then leaves the file.
- **Comments:** write a comment block under a task and the sync posts it as a rich-text ClickUp comment (headings, bullets, numbered steps, bold).
- **Safe by default:** your API token is kept in VS Code's secret storage, deleting a line never deletes a ClickUp task, and nothing syncs until you connect a workspace.

## The `TODO.md` format

```markdown
# TODO

## MISC TASKS

- [ ] **Fix the login redirect** <!-- cu:86abc123 -->
  The description, indented two spaces. Any Markdown works.

- [x] **Add a CSV export** <!-- cu:86abc456 -->
  Ticked = "in review" in ClickUp.

  <!-- comment -->
  ## Done
  - Exported **all** columns
  1. Open Reports
  2. Click Export
  <!-- /comment -->

## ANOTHER LIST

- [ ] **A new task**
  No `cu:` comment yet: the next sync creates it in "ANOTHER LIST" and writes its ID back.
```

- The heading a task sits under decides its ClickUp list. Tasks above the first heading go to the default list.
- Leave the `<!-- cu:… -->` comments alone. They link each line to its ClickUp task.
- Once a comment block is posted, its marker becomes `<!-- comment cu:ID -->` and it is never posted again.

## Sync rules

- The sync runs when `TODO.md` is saved or changed on disk, every few minutes, and when you click sync.
- Each field (name, description, tick, list) is merged on its own. A field changed on one side is copied to the other. If it changed on both sides, the newest edit wins.
- A task completed in ClickUp, or deleted there, leaves the file.
- A line deleted from the file comes back on the next sync. Delete tasks in ClickUp.
- A new task whose name matches an unlinked ClickUp task in the same list is linked to that task, not duplicated.
- While `TODO.md` has unsaved changes, the sync waits until you save.

## Setup

1. Build and install:
   ```sh
   npm install
   npm run package
   code --install-extension clickup-todo-*.vsix
   ```
2. Get a personal API token in ClickUp → Settings → Apps.
3. Open the **ClickUp TODO** view in the activity bar, click **Connect to ClickUp**, and paste the token.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `clickupTodo.file` | `TODO.md` | The task file, relative to the workspace folder. |
| `clickupTodo.defaultListId` | *(first list)* | The list shown first, and used for tasks above any heading. |
| `clickupTodo.excludedListIds` | `[]` | Lists left out of the sync. |
| `clickupTodo.reviewStatus` | `in review` | The status a ticked task gets. |
| `clickupTodo.syncIntervalMinutes` | `3` | How often changes made in ClickUp are pulled. |
| `clickupTodo.workspaceId` | *(first workspace)* | Which ClickUp workspace to use. |

A list ID is the number after `/li/` in the list's ClickUp URL.

## Development

```sh
npm test         # compile and run the tests (node:test, no VS Code needed)
npm run package  # build the .vsix
```

The sync engine (`src/sync.ts`), the file format (`src/todoFile.ts`) and the rich-text conversion (`src/richText.ts`) don't depend on VS Code. The tests run them against a fake ClickUp.

## License

MIT
