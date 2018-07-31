/**
 * Copyright (c) 2014-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import React from 'react';
import {createLRU} from './LRU';

import warningWithoutStack from 'shared/warningWithoutStack';

type Thenable<T> = {
  then(resolve: (T) => mixed, reject: (mixed) => mixed): mixed,
};

type Suspender = {
  then(resolve: () => mixed, reject: () => mixed): mixed,
};

type Subscription = {
  unsubscribe(): mixed,
};

type Observer<T> = {
  next(value: T): mixed,
  error(error: mixed): mixed,
  complete(): mixed,
};

type Observable<T> = {
  subscribe(observer: Observer<T>): Subscription,
};

type PendingResult = {|
  status: 0,
  value: Suspender,
|};

type UnobservableResult<V> = {|
  status: 1,
  value: V,
|};

type ResolvedResult<V> = {|
  status: 2,
  value: V,
|};

type RejectedResult = {|
  status: 3,
  value: mixed,
|};

type Result<V> =
  | PendingResult
  | UnobservableResult<V>
  | ResolvedResult<V>
  | RejectedResult;

type Resource<I, V> = {
  read(I): V,
};

type LRU<AddEntry, T> = {
  add: AddEntry,
  update(entry: $Call<AddEntry, T>, newValue: T): void,
  access(entry: $Call<AddEntry, T>): T,
  purge(): void,
};

type ResourceCache<AddEntry, K, V> = {
  // An LRU-managed map of results. When the result is evicted from the LRU, it
  // is also deleted from this map. An entry can be evicted whenever, but
  // mutations can only be applied in the commit phase.
  entries: Map<K, $Call<AddEntry, Result<V>>>,

  // A map of subscriptions. Each subscription belongs to an entry in the
  // `entries` map, although not every entry has a correspdonding subscription.
  // If an entry was found to be unreachable in the UI, its subscription is
  // disposed. The next time it is observed, a new subscription is created.
  subscriptions: Map<K, Subscription | Thenable<V>>,
};

type Cache<AddEntry> = {
  purge(maxSize: number): void,
  _lru: LRU<AddEntry, any>,
  _resourceCaches: Map<mixed, ResourceCache<AddEntry, any, any>>,
};

type ChangeSet<K, V> = {
  results: Map<K, Result<V>>,
  changedBits: number,
};

const Pending = 0;
const Unobservable = 1;
const Resolved = 2;
const Rejected = 3;

const never = {then() {}};

function identityHashFn(input) {
  if (__DEV__) {
    warningWithoutStack(
      typeof input === 'string' ||
        typeof input === 'number' ||
        typeof input === 'boolean' ||
        input === undefined ||
        input === null,
      'Invalid key type. Expected a string, number, symbol, or boolean, ' +
        'but instead received: %s' +
        '\n\nTo use non-primitive values as keys, you must pass a hash ' +
        'function as the second argument to createResource().',
      input,
    );
  }
  return input;
}

function calculateBitForKey(key: string | number) {
  if (typeof key === 'string') {
    // Hash the first 6 characters. Consider that some ids share a
    // common prefix.
    let hashCode = 0;
    for (let i = 0; i < key.length && i < 6; i++) {
      hashCode = (hashCode << (5 - hashCode)) + (key.charCodeAt(i) | 0);
    }
    return hashCode % 31;
  } else {
    // Assume it's a number
    // TODO: Warn for keys that are neither numbers nor strings
    const absoluteValue = (key ^ (key >> 31)) - (key >> 31);
    return absoluteValue % 31;
  }
}

function calculateChangeSetBits<K, V>(
  a: ChangeSet<K, V> | null,
  b: ChangeSet<K, V>,
): number {
  return b.changedBits;
}

function ReactDataCache(implementation: LRU<*, *>) {
  this._lru = implementation;
  this._resourceCaches = new Map();
}
ReactDataCache.prototype.purge = function() {
  return this._lru.purge();
};

const DEFAULT_LIMIT = 256;
const globalLRU = createLRU(DEFAULT_LIMIT);
export const globalCache: Cache<any> = new ReactDataCache(globalLRU);

const CacheContext = React.createContext(globalCache);

export function createResource<I, K: string | number, V>(
  load: I => Thenable<V> | Observable<V>,
  maybeHashInput: (I => K) | void,
): Resource<I, V> {
  const hashInput: I => K =
    maybeHashInput !== undefined ? maybeHashInput : (identityHashFn: any);

  // The initial change set is empty.
  let mostRecentChangeSet: ChangeSet<K, V> | null = null;
  const ChangeSetContext = React.createContext(
    mostRecentChangeSet,
    calculateChangeSetBits,
  );

  function scheduleChange(
    lru: LRU<*, *>,
    resourceCache: ResourceCache<*, K, V>,
    key: K,
    result: Result<V>,
  ) {
    const changedBits = calculateBitForKey(key);

    const baseChangeSet = mostRecentChangeSet;

    let newChangeSet;
    if (baseChangeSet === null) {
      const newResults = new Map([[key, result]]);
      newChangeSet = {
        results: newResults,
        changedBits,
      };
    } else {
      const baseResults = baseChangeSet.results;
      const newResults = new Map(baseResults);
      newResults.set(key, result);
      newChangeSet = {
        results: newResults,
        changedBits: changedBits | baseChangeSet.changedBits,
      };
    }

    mostRecentChangeSet = newChangeSet;
    ChangeSetContext.unstable_set(
      newChangeSet,
      changeSetDidCommit.bind(null, lru, resourceCache, newChangeSet),
    );
  }

  function changeSetDidCommit(
    lru: LRU<*, *>,
    resourceCache: ResourceCache<*, K, V>,
    newChangeSet: ChangeSet<K, V>,
  ): void {
    if (newChangeSet !== mostRecentChangeSet) {
      // There's a more recent set of changes.
      return;
    }

    const entries = resourceCache.entries;
    const subscriptions = resourceCache.subscriptions;
    const results = newChangeSet.results;

    // Apply the changes to the cache.
    results.forEach((result, key) => {
      const entry = entries.get(key);
      if (entry !== undefined) {
        // Update the entry and move it to the head of the LRU.
        lru.update(entry, result);
        lru.access(entry);
      } else {
        // Usually a result should already have a corresponding entry, but if it
        // does not, create a new one.
        addResultToCache(lru, resourceCache, key, result);
      }
    });

    // Now that all the changes have been applied, we can clear the change set.
    mostRecentChangeSet = null;

    // The following code may throw (`unsubscribe` is a user-provided function),
    // in which case subsequent subscriptions may not be disposed. It's not so
    // bad, though, because we can clean them up during the next update.

    // If a subscription was updated, but it was not used during the render
    // phase then it must not have any consumers.
    results.forEach((result, key) => {
      if (result.status !== Resolved) {
        const subscription = subscriptions.get(key);
        if (subscription !== undefined) {
          // This subscription has no consumers. Unsubscribe.
          subscriptions.delete(key);
          unsubscribe(subscription);
        }
      }
    });
  }

  function addResultToCache(lru, resourceCache, key, result) {
    const entries = resourceCache.entries;
    const entry = lru.add(
      result,
      deleteResultFromCache.bind(null, resourceCache, key),
    );
    entries.set(key, entry);
  }

  function deleteResultFromCache(
    resourceCache: ResourceCache<*, K, V>,
    key: K,
  ) {
    const entries = resourceCache.entries;
    const subscriptions = resourceCache.subscriptions;
    entries.delete(key);
    const subscription = subscriptions.get(key);
    if (subscription !== undefined) {
      unsubscribe(subscription);
    }
    subscriptions.delete(key);
  }

  function unsubscribe(subscription: Subscription | Thenable<V>) {
    if (typeof subscription.unsubscribe === 'function') {
      const sub: Subscription = (subscription: any);
      sub.unsubscribe();
    }
  }

  function resumeAll(resumes) {
    for (let i = 0; i < resumes.length; i++) {
      const resume = resumes[i];
      resume();
    }
  }

  function ensureSubscription(
    lru: LRU<*, *>,
    resourceCache: ResourceCache<*, K, V>,
    result: Result<V>,
    input: I,
    key: K,
  ): void {
    const subscriptions = resourceCache.subscriptions;
    const existingSubscription = subscriptions.get(key);
    if (existingSubscription !== undefined) {
      // There's already a matching subscription. Do not create a new one;
      // there cannot be more than one subscription per key.
      return;
    }

    const thenableOrObservable = load(input);

    // Check if the return value is a promise or an observable. Because
    // promises are more common, we'll assume it's a promise *unless* it's
    // an observable.
    let subscription;
    if (typeof thenableOrObservable.subscribe === 'function') {
      const observable: Observable<V> = (thenableOrObservable: any);

      let resumes = null;
      subscription = observable.subscribe({
        next(value: V) {
          if (result.status === Pending) {
            // This is the initial value.
            const unobservableResult: UnobservableResult<V> = (result: any);
            unobservableResult.status = Unobservable;
            unobservableResult.value = value;
            if (resumes !== null) {
              // Ping React to resume rendering.
              const r = resumes;
              resumes = null;
              resumeAll(r);
            }
          } else {
            // This is an update.
            const newResult: UnobservableResult<V> = {
              status: Unobservable,
              value,
            };
            scheduleChange(lru, resourceCache, key, newResult);
          }
        },
        error(error: mixed) {
          if (result.status === Pending) {
            // This is the initial value.
            const rejectedResult: RejectedResult = (result: any);
            rejectedResult.status = Rejected;
            rejectedResult.value = error;
            if (resumes !== null) {
              // Ping React to resume rendering.
              const r = resumes;
              resumes = null;
              resumeAll(r);
            }
          } else {
            // This is an update.
            const newResult: RejectedResult = {
              status: Rejected,
              value: error,
            };
            scheduleChange(lru, resourceCache, key, newResult);
          }
        },
        complete() {
          // No-op.
        },
      });

      if (result.status === Pending) {
        // The result is still pending. Create a thenable that resolves on the
        // initial value. We'll throw this to tell React to suspend the render.
        const pendingResult: PendingResult = (result: any);
        const suspender = {
          then(resume) {
            if (result.status === Pending) {
              if (resumes === null) {
                resumes = [resume];
              } else {
                resumes.push(resume);
              }
            } else {
              resume();
            }
          },
        };
        pendingResult.value = suspender;
      }
    } else {
      // This is a thenable.
      const thenable: Thenable<V> = (thenableOrObservable: any);
      subscription = thenable;
      thenable.then(
        value => {
          if (result.status === Pending) {
            // This is the initial value.
            const unobservableResult: UnobservableResult<V> = (result: any);
            unobservableResult.status = Unobservable;
            unobservableResult.value = value;
          } else {
            // This is an update.
            const newResult: UnobservableResult<V> = {
              status: Unobservable,
              value,
            };
            scheduleChange(lru, resourceCache, key, newResult);
          }
        },
        error => {
          if (result.status === Pending) {
            // This is the initial value.
            const rejectedResult: RejectedResult = (result: any);
            rejectedResult.status = Rejected;
            rejectedResult.value = error;
          } else {
            // This is an update.
            const newResult: RejectedResult = {
              status: Rejected,
              value: error,
            };
            scheduleChange(lru, resourceCache, key, newResult);
          }
        },
      );
      if (result.status === Pending) {
        // The record is still pending. Stash the thenable on the result.
        // We'll throw this to tell React to suspend the render.
        const pendingResult: PendingResult = (result: any);
        pendingResult.value = thenable;
      }
    }

    subscriptions.set(key, subscription);
  }

  function accessResult(input: I, key: K): Result<V> {
    const cache = CacheContext.unstable_read();
    const lru = cache._lru;

    let resourceCache = cache._resourceCaches.get(resource);
    if (resourceCache === undefined) {
      resourceCache = {
        entries: new Map(),
        subscriptions: new Map(),
      };
      cache._resourceCaches.set(resource, resourceCache);
    }

    const entries = resourceCache.entries;

    const observedBits = calculateBitForKey(key);
    const changeSet: ChangeSet<K, V> | null = ChangeSetContext.unstable_read(
      observedBits,
    );

    // Before reading from the cache, first check if there's a pending change
    // for this key.
    let result;
    if (changeSet !== null) {
      result = changeSet.results.get(key);
    }
    if (result !== undefined) {
      // This key has pending change. If the cache already includes a matching
      // value, disregard it and use the pending value instead.
      const entry = entries.get(key);
      if (entry !== undefined) {
        // Found a matching entry. Move to the head of the LRU, but don't use
        // the cached value.
        lru.access(entry);
      } else {
        // No matching entry was found. It's ok to add it to the cache
        // immediately instead of waiting for the change to commit.
        addResultToCache(lru, resourceCache, key, result);
      }
    } else {
      // This key does not have a pending change. Check the cache.
      const entry = entries.get(key);
      if (entry !== undefined) {
        // Found a matching entry.
        result = lru.access(entry);
      } else {
        // No matching entry was found. Add it to the cache.
        const pendingResult: PendingResult = (result = {
          status: Pending,
          value: never,
        });
        addResultToCache(lru, resourceCache, key, pendingResult);
      }
    }

    // Ensure the result has a matching subscription
    ensureSubscription(lru, resourceCache, result, input, key);

    return result;
  }

  const resource = {
    read(input: I): V {
      const key = hashInput(input);
      const result: Result<V> = accessResult(input, key);
      switch (result.status) {
        case Pending: {
          const suspender = result.value;
          throw suspender;
        }
        case Unobservable: {
          const resolvedResult: ResolvedResult<V> = (result: any);
          resolvedResult.status = Resolved;
          const value = resolvedResult.value;
          return value;
        }
        case Resolved: {
          const value = result.value;
          return value;
        }
        case Rejected: {
          const error = result.value;
          throw error;
        }
        default:
          // Should be unreachable
          return (undefined: any);
      }
    },

    preload(input: I): void {
      const key = hashInput(input);
      accessResult(input, key);
    },
  };
  return resource;
}

export function useCache() {
  return CacheContext.unstable_read();
}

export function setGlobalCacheLimit(limit: number) {
  globalLRU.setLimit(limit);
}
