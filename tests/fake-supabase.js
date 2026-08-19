// A stand-in for the Supabase client, good enough for the query shapes this
// app actually builds. It records every call so tests can assert on ordering,
// filters and payloads, and returns whatever the handler decides.
//
// The builder is thenable, which is what lets `await supabase.from(x).select()`
// resolve the same way the real client does.

export function createFakeClient(handler = () => ({ data: [] })) {
  const calls = [];

  function from(table) {
    const call = {
      table,
      op: 'select',
      payload: null,
      options: null,
      filters: [],
      modifiers: [],
      columns: null,
      single: false,
      settled: false,
    };
    calls.push(call);

    const builder = {
      select(columns) {
        call.columns = columns ?? '*';
        return builder;
      },
      insert(payload) {
        call.op = 'insert';
        call.payload = payload;
        return builder;
      },
      upsert(payload, options) {
        call.op = 'upsert';
        call.payload = payload;
        call.options = options ?? null;
        return builder;
      },
      update(payload) {
        call.op = 'update';
        call.payload = payload;
        return builder;
      },
      eq(column, value) {
        call.filters.push({ type: 'eq', column, value });
        return builder;
      },
      is(column, value) {
        call.filters.push({ type: 'is', column, value });
        return builder;
      },
      ilike(column, value) {
        call.filters.push({ type: 'ilike', column, value });
        return builder;
      },
      order(column, options) {
        call.modifiers.push({ type: 'order', column, options: options ?? null });
        return builder;
      },
      limit(count) {
        call.modifiers.push({ type: 'limit', count });
        return builder;
      },
      single() {
        call.single = true;
        return builder;
      },
      then(onFulfilled, onRejected) {
        return Promise.resolve()
          .then(() => {
            call.settled = true;
            const result = handler(call) ?? {};
            return { data: result.data ?? null, error: result.error ?? null };
          })
          .then(onFulfilled, onRejected);
      },
    };

    return builder;
  }

  return { client: { from }, calls };
}

// Convenience: route results per table, falling back to an empty success.
export function byTable(map) {
  return (call) => {
    const entry = map[call.table];
    return typeof entry === 'function' ? entry(call) : (entry ?? { data: [] });
  };
}

export function pgError(code, message = `simulated ${code}`) {
  return { code, message };
}
