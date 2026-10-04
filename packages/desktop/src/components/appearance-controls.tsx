import {
  useAppearance,
  setAppearance,
  useComposerPreferences,
  setComposerPreferences,
} from "../appearance.ts";
import { accents } from "../preferences.ts";
import { Button, Checkbox, Input, Select } from "../ui.tsx";

export function AppearanceControls() {
  const appearance = useAppearance();
  return (
    <div className="appearance-controls">
      <div className="preference-row">
        <div className="preference-copy">
          <h3>Theme</h3>
          <p>Follow your system or pick a theme.</p>
        </div>
        <div className="theme-options" aria-label="Theme">
          {(["system", "light", "dark"] as const).map((theme) => (
            <Button
              key={theme}
              size="sm"
              variant={appearance.theme === theme ? "accent" : "neutral"}
              aria-pressed={appearance.theme === theme}
              onClick={() => setAppearance({ ...appearance, theme })}
            >
              {theme.charAt(0).toUpperCase() + theme.slice(1)}
            </Button>
          ))}
        </div>
      </div>
      <div className="preference-row">
        <div className="preference-copy">
          <h3>Accent</h3>
          <p>A little color on buttons and selections.</p>
        </div>
        <div className="accent-choices">
          <div className="accent-options">
            {accents.map(([label, color]) => (
              <button
                key={label}
                type="button"
                className="swatch"
                aria-label={label}
                aria-pressed={appearance.accent.toLowerCase() === color}
                style={{ background: color }}
                onClick={() => setAppearance({ ...appearance, accent: color })}
              />
            ))}
          </div>
          <label className="color-choice">
            Custom accent
            <Input
              type="color"
              value={appearance.accent}
              onChange={(event) => setAppearance({ ...appearance, accent: event.target.value })}
            />
          </label>
        </div>
      </div>
      <label className="preference-row">
        <span className="preference-copy">
          <span className="preference-title">Button depth</span>
          <span className="preference-hint">The colored edge underneath a button.</span>
        </span>
        <Select
          value={appearance.depth}
          onChange={(event) => setAppearance({ ...appearance, depth: Number(event.target.value) })}
        >
          {[1, 2, 3, 4, 5].map((value) => (
            <option key={value} value={value}>
              {value}px
            </option>
          ))}
        </Select>
      </label>
      <label className="preference-row">
        <span className="preference-copy">
          <span className="preference-title">Corner radius</span>
          <span className="preference-hint">Keep controls crisp or soften their corners.</span>
        </span>
        <Select
          value={appearance.radius}
          onChange={(event) => setAppearance({ ...appearance, radius: Number(event.target.value) })}
        >
          {[5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((value) => (
            <option key={value} value={value}>
              {value}px
            </option>
          ))}
        </Select>
      </label>
    </div>
  );
}
export function ComposerSettings() {
  const preferences = useComposerPreferences();
  return (
    <div className="form-grid composer-settings">
      <label>
        Send message with
        <Select
          value={preferences.sendWith}
          onChange={(event) =>
            setComposerPreferences({
              ...preferences,
              sendWith: event.target.value as "Enter" | "Shift+Enter",
            })
          }
        >
          <option>Enter</option>
          <option>Shift+Enter</option>
        </Select>
      </label>
      <p className="muted">
        {preferences.sendWith === "Enter" ? "Shift+Enter" : "Enter"} inserts a newline. Ctrl/⌘+Enter
        uses the other delivery action while working.
      </p>
      <label>
        While working, default to
        <Select
          value={preferences.delivery}
          onChange={(event) =>
            setComposerPreferences({
              ...preferences,
              delivery: event.target.value as "queue" | "steer",
            })
          }
        >
          <option value="queue">Queue</option>
          <option value="steer">Steer</option>
        </Select>
      </label>
      <label className="check-label">
        <Checkbox
          checked={preferences.showStats}
          onChange={(event) =>
            setComposerPreferences({ ...preferences, showStats: event.target.checked })
          }
        />{" "}
        Show last-turn statistics
      </label>
    </div>
  );
}
