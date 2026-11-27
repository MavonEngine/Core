/**
 * An ES module `use-sync-external-store/shim/with-selector`, which React Flow's store (zustand) imports. The package
 * is CommonJS and calls `require('react')`: with react external to the editor's bundle, that require stays in it and
 * fails in the browser. React 19 has useSyncExternalStore, so only the selector part is needed.
 *
 * Ported from React's use-sync-external-store (MIT, Copyright (c) Meta Platforms, Inc. and affiliates).
 */
import { useDebugValue, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'

export function useSyncExternalStoreWithSelector<Snapshot, Selection>(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => Snapshot,
  getServerSnapshot: undefined | null | (() => Snapshot),
  selector: (snapshot: Snapshot) => Selection,
  isEqual?: (a: Selection, b: Selection) => boolean,
): Selection {
  // The last selection, to hand back the same object while it is equal
  const instRef = useRef<{ hasValue: boolean, value: Selection | null } | null>(null)
  instRef.current ??= { hasValue: false, value: null }
  const inst = instRef.current

  const [getSelection, getServerSelection] = useMemo(() => {
    let hasMemo = false
    let memoizedSnapshot: Snapshot
    let memoizedSelection: Selection

    const memoizedSelector = (nextSnapshot: Snapshot): Selection => {
      if (!hasMemo) {
        hasMemo = true
        memoizedSnapshot = nextSnapshot
        const nextSelection = selector(nextSnapshot)
        if (isEqual !== undefined && inst.hasValue) {
          const currentSelection = inst.value as Selection
          if (isEqual(currentSelection, nextSelection)) {
            memoizedSelection = currentSelection
            return currentSelection
          }
        }
        memoizedSelection = nextSelection
        return nextSelection
      }

      const prevSelection = memoizedSelection
      if (Object.is(memoizedSnapshot, nextSnapshot))
        return prevSelection

      const nextSelection = selector(nextSnapshot)
      if (isEqual !== undefined && isEqual(prevSelection, nextSelection)) {
        memoizedSnapshot = nextSnapshot
        return prevSelection
      }
      memoizedSnapshot = nextSnapshot
      memoizedSelection = nextSelection
      return nextSelection
    }

    return [
      () => memoizedSelector(getSnapshot()),
      getServerSnapshot == null
        ? undefined
        : () => memoizedSelector(getServerSnapshot()),
    ] as const
  }, [
    getSnapshot,
    getServerSnapshot,
    selector,
    isEqual,
    inst,
  ])

  const value = useSyncExternalStore(subscribe, getSelection, getServerSelection)

  useEffect(() => {
    inst.hasValue = true
    inst.value = value
  }, [inst, value])

  useDebugValue(value)
  return value
}

// The package is CommonJS, imported as a default object
export default { useSyncExternalStoreWithSelector }
