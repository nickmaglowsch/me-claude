# Task 01: Project Scaffold

## Objective
Create all project-level configuration files for a greenfield TypeScript/Node.js project so that subsequent tasks can immediately start writing source files.

## Context

**Quick Context:**
- Greenfield project — all files are net-new, nothing to migrate
- `data/` directory must exist at project root (holds `voice_profile.md` and `session/` at runtime)
- See `tasks/main/shared-context.md` for full tech stack and conventions

## Requirements

### `package.json`
- `name`: `whatsapp-ai-bot`
- `version`: `"1.0.0"`
- `private`: `true`
- No `"type": "module"` field (CommonJS)
- Scripts:
  ```json
  {
    "start":      "tsx src/index.ts",
    "setup":      "tsx src/setup.ts",
    "build":      "tsc",
    "test":       "vitest run",
    "test:watch": "vitest"
  }
  ```
- Runtime dependencies:
  - `whatsapp-web.js`: latest
  - `qrcode-terminal`: latest
- Dev dependencies:
  - `typescript`: `^5.0.0`
  - `tsx`: latest
  - `@types/node`: `^20.0.0`
  - `vitest`: latest

### `tsconfig.json`
Exact settings (no deviation):
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "strict": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### `.gitignore`
Must contain exactly these entries (no more, no less):
```
node_modules/
dist/
data/session/
data/voice_profile.md
.env
*.log
```

### Directory structure
After this task, the repo layout should be:
```
/
├── package.json
├── tsconfig.json
├── .gitignore
├── data/          # runtime artifacts directory (create empty, with .gitkeep if needed)
└── src/           # source files directory (create empty)
```

Run `npm install` to confirm the lockfile generates cleanly (no errors).

## Existing Code References
None — this is a greenfield project with no pre-existing code.

## Implementation Details
- Create `data/` directory at project root (not inside `src/`)
- Create `src/` directory at project root
- Both directories start empty; use `.gitkeep` files if needed to commit them

## Acceptance Criteria
- [ ] `package.json` exists with all scripts, runtime deps, and dev deps listed above
- [ ] `tsconfig.json` exists with all listed compiler options exactly as specified
- [ ] `.gitignore` exists with exactly the 6 entries listed above (`node_modules/`, `dist/`, `data/session/`, `data/voice_profile.md`, `.env`, `*.log`)
- [ ] `src/` directory exists
- [ ] `data/` directory exists
- [ ] `npm install` completes without errors
- [ ] `npm run build` with an empty or minimal `src/` stub exits 0

## Dependencies
- Depends on: None
- Blocks: All other tasks
