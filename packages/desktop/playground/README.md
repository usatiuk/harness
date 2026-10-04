# Desktop design playground

A local design study and component specimen for the
[conversation-first desktop refactor](../../../docs/plans/interface/2026-10-04-desktop-design-system.md).
It uses the production desktop's typed React controls and semantic CSS tokens,
with Radix Primitives, Tailwind v4 and Lucide. It does not connect to Harness or
execute commands. Install the repository dependencies before this package.
Preview hosts, conversations, drafts, messages, approval decisions, forms, and
connection actions stay in memory. Switching hosts remembers the selected chat;
each chat retains its draft, model and preview status. These are sample hosts,
not live connections. Appearance and composer preferences are remembered in
this study's own browser preference keys.

```powershell
cd packages/desktop/playground
npm install
npm run dev
```

Open `http://127.0.0.1:1430`. Conversation shows the intended information hierarchy;
Components exercises controls, forms, dialogs, menus, and state feedback;
Foundations shows palette, type, spacing, and depth. Appearance offers
light/dark/system, six pastel presets, custom accent, and shallow-edge sizing.

Components includes a canvas/panel button-state comparison. Hover, press, Tab,
or toggle selection to inspect the shared recipes. Its **Check text contrast**
action runs axe-core's `color-contrast` rule against the rendered page in the
current theme and reports failures and cases requiring manual review. This is
a snapshot audit of visible text, not a full accessibility qualification or a
measurement of button boundaries/selection prominence.

The composer uses Enter to send, Shift+Enter for a newline, and Ctrl/Cmd+Enter
for the other Queue/Steer action while working. Composer settings let you swap
Enter and Shift+Enter, choose the default delivery mode, and toggle last-turn
stats. The context ring opens a token breakdown. Context and turn metrics are
sample values; this study does not measure or execute a real turn. All icons
use Lucide; the context ring is a CSS data indicator.

`npm run check` verifies formatting, JavaScript syntax, and a production build.
The specimen imports `../../src/ui.tsx` and the production token/control styles;
Vite deduplicates React/Radix/Lucide across the two installation roots. Sample
application state and browser preference keys stay isolated from the real desktop.
See the delivery plan for production/native verification evidence and limits.
