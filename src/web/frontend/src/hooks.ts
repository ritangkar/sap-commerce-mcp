import { useCallback, useRef, useState } from "react";
import { errorText } from "./api";

export type RunState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: T; at: Date }
  | { status: "error"; error: { code: string; message: string } };

/** Runs an async action, tracking idle / loading / success / error. Ignores results of superseded runs. */
export function useRun<T, A extends unknown[]>(action: (...args: A) => Promise<T>) {
  const [state, setState] = useState<RunState<T>>({ status: "idle" });
  const latest = useRef(0);
  const run = useCallback(
    async (...args: A) => {
      const id = ++latest.current;
      setState({ status: "loading" });
      try {
        const data = await action(...args);
        if (id === latest.current) setState({ status: "success", data, at: new Date() });
      } catch (e) {
        if (id === latest.current) setState({ status: "error", error: errorText(e) });
      }
    },
    [action]
  );
  return [state, run] as const;
}

export function useStored(key: string, initial: string): [string, (v: string) => void] {
  const [value, setValue] = useState(() => {
    try {
      return window.localStorage.getItem(key) ?? initial;
    } catch {
      return initial;
    }
  });
  const set = (v: string) => {
    setValue(v);
    try {
      window.localStorage.setItem(key, v);
    } catch {
      /* storage unavailable: preference just isn't remembered */
    }
  };
  return [value, set];
}
