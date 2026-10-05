/** A text field from a submitted form; never a File or `null` stringified by accident. */
export function textField(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}
