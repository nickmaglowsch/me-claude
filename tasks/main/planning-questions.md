# Planning Questions

## Codebase Summary

This is a greenfield project — no existing code. The PRD is highly prescriptive: it specifies exact file layout, dependencies, behavior per phase, package scripts, prompts (verbatim), and README contents. The questions below cover only decisions the PRD genuinely leaves open that would materially change the implementation.

## Questions

### Q1: TypeScript configuration — emit mode
**Context:** The PRD specifies `npm run build` compiles TypeScript to `dist/`, which implies real `tsc` emit. But `npm start` and `npm run setup` use `tsx` (or `ts-node`) to run source files directly without compiling first. This is the standard "tsx for dev, tsc for prod" split, which is fine — but it means `tsconfig.json` should be configured for actual emit (`outDir: "dist"`, no `noEmit`), with strict mode and a reasonable `target`/`module` setting for Node 20.
**Question:** Should `tsconfig.json` target ESNext/NodeNext (modern ES modules) or CommonJS? The choice affects import syntax (`import` vs `require`) throughout the source files and whether `package.json` needs `"type": "module"`.
**Options:**
- A) CommonJS — simpler, avoids ESM gotchas with `whatsapp-web.js`, no `"type": "module"` needed
- B) ESM (NodeNext target) — modern, but `whatsapp-web.js` has had ESM compatibility issues historically; requires `.js` extensions on imports or `moduleResolution: bundler`

### Q2: `callClaude` stdin fallback threshold
**Context:** The PRD says "if too long, fall back to stdin." The META_PROMPT filled with ~400 messages could easily exceed shell argument limits (~2MB on Linux for `execve`, but `spawn` in Node passes args differently — the practical limit for a single arg via `spawn` is around 128KB before things get unreliable). The RUNTIME_PROMPT is shorter but the voice profile is added into it.
**Question:** Should the stdin fallback always be used (simplest and safest), or only above a character threshold? If a threshold, what value — 100K chars is a reasonable safe default.
**Options:**
- A) Always use stdin — pipe the prompt via stdin unconditionally, simpler code, zero risk of arg-length issues
- B) Threshold-based — use `-p arg` below ~100K chars, fall back to stdin above it
- C) Arg only — trust that Node `spawn` handles large strings (likely fine in practice but not guaranteed)

### Q3: Owner ID detection
**Context:** The RUNTIME phase needs `ownerId` to filter mentions (`msg.mentionedIds.includes(ownerId)`). The PRD doesn't specify where this value comes from. Two viable sources: (1) derive it at startup from `client.info.wid._serialized` (the authenticated user's own ID, available after the `ready` event), or (2) require the user to set it in a `.env` file or config.
**Question:** Where should `ownerId` come from?
**Options:**
- A) Derive from `client.info.wid._serialized` at startup — zero config, auto-correct, but `_serialized` is an internal `whatsapp-web.js` field that could change
- B) Require user to set `OWNER_ID` in a `.env` file — explicit, stable, but adds a setup step
- C) Derive at startup AND log the detected ID prominently so the user can verify and override via env if needed

### Q4: Entry point — one file or two
**Context:** The PRD specifies `src/index.ts` as the entry point for runtime mode and `src/setup.ts` as the entry point for setup mode (`npm run setup` → `src/setup.ts`). This implies two separate entry points, not a CLI flag on a single `index.ts`. But `src/index.ts` still needs to exist as the runtime entry point.
**Question:** Is the intent that `npm run setup` runs `src/setup.ts` directly (bypassing `src/index.ts` entirely), or should `src/index.ts` accept a `--setup` flag and dispatch internally?
**Options:**
- A) Two separate entry points — `npm start` → `src/index.ts`, `npm run setup` → `src/setup.ts` (simpler, matches PRD file layout literally)
- B) Single entry point — `src/index.ts` with a `--setup` flag; `setup.ts` becomes a module not an entry point

### Q5: TDD mode
**Context:** The PRD includes a specific smoke test requirement: "loads prompts, fills in dummy values, prints the final prompt string — verifies templates work without calling Claude or WhatsApp." This is the only test specified.
**Question:** Beyond the required smoke test for prompt templates, do you want TDD mode for this build? If yes, the task implementer will write failing tests before implementation code for each functional task (using a framework like Vitest or Jest).
**Options:**
- A) No — just the smoke test the PRD requires; no additional test infrastructure
- B) Yes — TDD for each task; install Vitest (lightweight, TypeScript-native) and write tests first

