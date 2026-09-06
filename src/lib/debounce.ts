/** A trailing-edge debounce — used for autosave and for anything else that
 *  should coalesce a burst of edits into one call. */
export function debounce<Args extends unknown[]>(fn: (...args: Args) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = (...args: Args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return debounced;
}
