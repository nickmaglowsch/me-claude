# WhatsApp AI Voice Bot — Task Plan

These files are prompts for AI agents. Delete each task file after it is completed. When all task files are deleted, the feature is complete.

## Summary

Build a Node.js/TypeScript WhatsApp bot that:
1. **Setup mode** (`npm run setup`): scrapes ALL chat history (groups + DMs), builds a voice profile via Claude CLI, writes `data/voice_profile.md`
2. **Runtime mode** (`npm start`): listens for group mentions of the owner, fetches a before/after context window, calls Claude with the voice profile, replies in the owner's voice

Greenfield project — all files are net-new.

## Task List

| # | File | Description | TDD? |
|---|------|-------------|------|
| 01 | `task-01-scaffold.md` | `package.json`, `tsconfig.json`, `.gitignore`, `src/` and `data/` dirs | No |
| 02 | `task-02-prompts.md` | `src/prompts.ts` — verbatim prompt constants + `fillTemplate` (single-brace `{KEY}`) | Yes |
| 03 | `task-03-claude.md` | `src/claude.ts` — subprocess wrapper, stdin, 60s timeout | Yes |
| 04 | `task-04-extract.md` | `src/extract.ts` — filter, per-chat stratified sample, shuffle, volume check, format | Yes |
| 05 | `task-05-whatsapp.md` | `src/whatsapp.ts` — client init, `fetchAllChats`, `formatMessageLine`, pure helpers | Yes (helpers only) |
| 06 | `task-06-setup.md` | `src/setup.ts` — iterates ALL chats, stratified sample, writes `data/voice_profile.md` | No |
| 07 | `task-07-runtime.md` | `src/index.ts` — listener, 10s rate limit, before/after context window, mention detection | Yes (pure helpers) |
| 08 | `task-08-readme.md` | `README.md` — project documentation | No |

**Total tasks:** 8
**Complexity:** Medium — greenfield but well-specified; WA client integration is the main risk area.

## Dependency Graph

```
Task 01 (scaffold)
  ├── Task 02 (prompts)     ──┐
  ├── Task 03 (claude)      ──┤─── Task 06 (setup)
  ├── Task 04 (extract)     ──┤
  └── Task 05 (whatsapp)    ──┘
                             └── Task 07 (runtime)
Task 01 ──────────────────────── Task 08 (README)
```

- Task 01 must complete before any other task
- Tasks 02, 03, 04, 05 can run in parallel after Task 01
- Task 05 depends on Task 04 (imports `RawMessage` type)
- Task 06 (setup.ts) depends on Tasks 02, 03, 04, 05
- Task 07 (index.ts) depends on Tasks 02, 03, 05
- Task 08 (README) depends only on Task 01

## Key Corrections from PRD Revision

The following are critical spec details that differ from common assumptions — agents must follow the task files exactly:

1. **Single-brace placeholders**: `{MESSAGES_GO_HERE}`, `{VOICE_PROFILE_GOES_HERE}`, `{BEFORE_MESSAGES}`, `{MENTION_MESSAGE}`, `{AFTER_MESSAGES}` — NOT double-brace `{{key}}`
2. **Runtime context window**: fetches up to 10 before-messages + 8s wait + up to 10 after-messages; fills all four RUNTIME_PROMPT placeholders
3. **Rate limit**: 10 seconds per group — not 60
4. **Message filter**: `fromMe=true`, `type='chat'`, `body.length>=3`, not `'<Media omitted>'` — does NOT drop numeric bodies
5. **Sampling**: per-chat stratification (`stratifiedSampleByChat`, 50 per chat) — not by month
6. **Fetch limit**: 500 per chat — not 2000
7. **All chats in setup**: `fetchAllChats` (groups + DMs) — not just groups
8. **Mention detection**: `chat.isGroup`, `msg.mentionedIds.includes(ownerId)`, `!msg.fromMe` — all three required
9. **File paths**: `data/voice_profile.md` and `data/session/` — not project root
10. **Verbatim prompts**: embedded in `task-02-prompts.md` and `updated-prd.md` — no placeholders remain

## How to Use

1. Assign Task 01 to an agent. It must complete before anything else.
2. Assign Tasks 02–05 to agents in parallel (or sequentially in any order). Note Task 05 depends on Task 04's `RawMessage` type.
3. Assign Task 06 after Tasks 02–05 complete.
4. Assign Task 07 after Tasks 02, 03, and 05 complete.
5. Assign Task 08 any time after Task 01.
6. Delete each task file as the agent completes it.
7. When all 8 task files are gone, the project is built.

## Context Files

Each task file references:
- `tasks/main/shared-context.md` — tech stack, test infra, conventions, key file table
- `tasks/main/updated-prd.md` — full codebase-aware PRD with all architectural decisions

Both files are ephemeral (regenerated if the plan is re-run) and do not need to be deleted manually.
