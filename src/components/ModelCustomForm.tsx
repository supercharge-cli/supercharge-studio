/** Typed model id form (lazy). `tid` prefixes test ids. */
export function ModelCustomForm({ id, name, onId, onName, onBack, onSave, tid = "model", busy }: {
  id: string; name: string; tid?: string; busy?: boolean;
  onId: (v: string) => void; onName: (v: string) => void;
  onBack: () => void; onSave: () => void;
}) {
  return (
    <form className="model-custom-form m-custom-model" data-testid={`${tid}-custom-form`} onSubmit={(e) => { e.preventDefault(); onSave(); }}>
      <label>Model id<input autoFocus data-testid={`${tid}-custom-id`} value={id} onChange={(e) => onId(e.target.value)} placeholder="vendor/model" /></label>
      <label>Name <span className="muted">(optional)</span><input data-testid={`${tid}-custom-name`} value={name} onChange={(e) => onName(e.target.value)} placeholder="Picker label" /></label>
      <div className="row">
        <button type="button" className="secondary" data-testid={`${tid}-custom-back`} onClick={onBack}>Back</button>
        <button type="submit" data-testid={`${tid}-custom-save`} disabled={!id.trim() || busy}>Use model</button>
      </div>
    </form>
  );
}
