// Finite state machine. Several behaviors are wrong or missing (SPEC.md).

export function createMachine(spec) {
  let current = spec.initial;
  const history = [current];
  return {
    get state() { return current; },
    send(type, payload) {
      const st = spec.states[current];
      const target = st.on && st.on[type];
      if (!target) return current;
      current = target;
      history.push(current);
      return current;
    },
    history() { return history; },
  };
}
