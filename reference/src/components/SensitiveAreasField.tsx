/**
 * SensitiveAreasField.tsx — the per-project "sensitive areas" list.
 *
 * The non-technical planning guardrail: the parts of this application a
 * non-technical user must not change without a technical review. Blank means
 * the guardrail is off for the project. Shared by the New Project modal and
 * the Edit project page so both say the same thing.
 */

export const SENSITIVE_AREAS_HINT =
  'Parts of this application a non-technical user must not change without a technical review — one bullet per area, in plain or technical wording (tables, screens, features, load-sensitive queries). Leave empty to disable the guardrail.';

export const SENSITIVE_AREAS_PLACEHOLDER =
  '- The orders tables and every query that reads them\n- Checkout and payment flows\n- Anything that adds a migration or a background job';

export interface SensitiveAreasFieldProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

function SensitiveAreasField({ value, onChange, disabled = false }: SensitiveAreasFieldProps) {
  return (
    <div className="space-y-2">
      <label htmlFor="sensitive-areas" className="text-sm font-medium text-foreground">
        Sensitive areas{' '}
        <span className="font-normal text-muted-foreground">(non-technical requests)</span>
      </label>
      <textarea
        id="sensitive-areas"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={SENSITIVE_AREAS_PLACEHOLDER}
        rows={4}
        disabled={disabled}
        spellCheck={false}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
        data-testid="sensitive-areas-input"
      />
      <p className="text-xs text-muted-foreground">{SENSITIVE_AREAS_HINT}</p>
    </div>
  );
}

export default SensitiveAreasField;
