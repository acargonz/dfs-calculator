# DFS Calculator - Complete Setup Guide (Mac + Windows)

---

## PHASE 1: Install the Calculator

### Step 1A: Install Node.js

**Mac:**
1. Go to https://nodejs.org in Safari
2. Download the macOS installer (green "LTS" button, currently v22)
3. Double-click the .pkg and follow the installer
4. Open Terminal (Cmd+Space, type "Terminal", Enter)
5. Verify: `node --version` and `npm --version`

**Windows:**
1. Go to https://nodejs.org in Chrome/Edge
2. Download the Windows installer (green "LTS" button)
3. Run the .msi, click Next through everything
4. Open PowerShell (Windows key, type "PowerShell", Enter)
5. Verify: `node --version` and `npm --version`

### Step 1B: Unzip and Install

**Mac:**
```bash
cd ~/Documents/dfs-calculator
npm install
npm test
```

**Windows:**
```powershell
cd C:\Users\AC\Documents\dfs-calculator
npm install
npm test
```

You should see: `Tests: 50 passed, 50 total`

Then run: `npm run dev` and open http://localhost:3000

---

## PHASE 2: Install Claude Code

**Requirement:** Claude Pro ($20/month) or Claude Max subscription.

### Step 2A: Install

**Mac (native installer):**
```bash
curl -fsSL https://claude.ai/install.sh | bash
```
Close Terminal, open a new one, verify: `claude --version`

**Windows (native installer):**
```powershell
irm https://claude.ai/install.ps1 | iex
```
Close PowerShell, open a new one, verify: `claude --version`

If native installer fails on Windows, use npm:
```powershell
npm install -g @anthropic-ai/claude-code
claude --version
```

### Step 2B: Authenticate

```bash
claude
```
Browser opens -> sign in with your Claude account -> done.
Type `/quit` to exit for now.

---

## PHASE 3: Connect to Your Project

```bash
cd ~/Documents/dfs-calculator    # Mac
cd C:\Users\AC\Documents\dfs-calculator    # Windows
claude
```

Claude Code reads AGENTS.md automatically. Test it:
```
Read AGENTS.md and summarize the project. Then run npm test.
```

---

## PHASE 4: Add MCP Servers

### Context7 (live documentation)
```bash
claude mcp add context7 -- npx -y @upstash/context7-mcp@latest
```
Usage: add "use context7" to prompts about libraries.

### Verify MCP servers
```bash
claude mcp list
```

---

## PHASE 5: The Workflow

1. Always start in your project folder, then run `claude`
2. Give small specific tasks
3. Always say "run npm test after"
4. If something breaks, describe the error and let Claude Code fix it
5. Update AGENTS.md when the project evolves

### Example session:
```
You: Add a form with inputs for player name, mean, line,
     position dropdown, stat type dropdown, and odds fields.
     Run npm test after.

You: Wire the form to call modelCountingStat() and display
     the probabilities. Run npm test after.

You: Add devigProbit using the odds inputs, blend with model
     probability, show all results. Run npm test after.
```

Small tasks. Test after each. Build up incrementally.

---

## Troubleshooting

- "command not found: claude" -> Close terminal, open new one
- "EACCES permission denied" -> Never use sudo. Use nvm instead.
- Tests fail -> Tell Claude Code the error, let it fix only the broken part
- Windows auth issues -> Use API key: set ANTHROPIC_API_KEY env variable
