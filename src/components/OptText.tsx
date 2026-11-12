/** A config choice in full: name, the exact id (never truncated; ids are unique) and the description. */
export const OptText = ({ o }: { o: { value: string; name?: string; description?: string } }) => (
  <span className="opt">
    <b>{o.name || o.value}</b>
    {o.name && o.name !== o.value && <code>{o.value}</code>}
    {o.description && <small>{o.description}</small>}
  </span>
);
