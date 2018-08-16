/**
 * Copyright (c) 2014-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import {scheduleWork} from 'react-scheduler';

type Entry<T> = {|
  value: T,
  onDelete: () => mixed,
  previous: Entry<T>,
  next: Entry<T>,
|};

export function createLRU<T>(limit: number) {
  let LIMIT = limit;

  // Circular, doubly-linked list
  let first: Entry<T> | null = null;
  let size: number = 0;

  let cleanUpIsScheduled: boolean = false;

  function scheduleCleanUp() {
    if (cleanUpIsScheduled === false && size > LIMIT) {
      // The cache size exceeds the limit. Schedule a callback to delete the
      // least recently used entries.
      cleanUpIsScheduled = true;
      scheduleWork(cleanUp);
    }
  }

  function cleanUp() {
    cleanUpIsScheduled = false;
    deleteLeastRecentlyUsedEntries(LIMIT);
  }

  function deleteLeastRecentlyUsedEntries(targetSize: number) {
    // Delete entries from the cache, starting from the end of the list.
    if (first !== null) {
      const resolvedFirst: Entry<T> = (first: any);
      let last = resolvedFirst.previous;
      while (size > targetSize && last !== null) {
        const onDelete = last.onDelete;
        const previous = last.previous;
        last.onDelete = (null: any);

        // Remove from the list
        last.previous = last.next = (null: any);
        if (last === first) {
          // Reached the head of the list.
          first = last = null;
        } else {
          (first: any).previous = previous;
          previous.next = (first: any);
          last = previous;
        }

        size -= 1;

        // Call the destroy method after removing the entry from the list. If it
        // throws, the rest of cache will not be deleted, but it will be in a
        // valid state.
        onDelete();
      }
    }
  }

  function add(value: T, onDelete: () => mixed): Entry<T> {
    const entry = {
      value,
      onDelete,
      next: (null: any),
      previous: (null: any),
    };
    if (first === null) {
      entry.previous = entry.next = entry;
      first = entry;
    } else {
      // Append to head
      const last = first.previous;
      last.next = entry;
      entry.previous = last;

      first.previous = entry;
      entry.next = first;

      first = entry;
    }
    size += 1;
    return entry;
  }

  function update(entry: Entry<T>, newValue: T): void {
    entry.value = newValue;
  }

  // function deleteEntry<T>(entry: Entry<T>): void {
  //   const previous = entry.previous;
  //   const next = entry.next;
  //   const onDelete = entry.onDelete;

  //   entry.next = entry.previous = null;
  //   if (entry === previous) {
  //     first = null;
  //   } else {
  //     if (entry === first) {
  //       first = next;
  //     }
  //     previous.next = next;
  //     next.previous = previous;
  //   }

  //   onDelete();
  // }

  function access(entry: Entry<T>): T {
    const next = entry.next;
    if (next !== null) {
      // Entry already cached
      const resolvedFirst: Entry<T> = (first: any);
      if (first !== entry) {
        // Remove from current position
        const previous = entry.previous;
        previous.next = next;
        next.previous = previous;

        // Append to head
        const last = resolvedFirst.previous;
        last.next = entry;
        entry.previous = last;

        resolvedFirst.previous = entry;
        entry.next = resolvedFirst;

        first = entry;
      }
    } else {
      // TODO: Better error message
      throw new Error('Cannot access a deleted entry');
    }
    scheduleCleanUp();
    return entry.value;
  }

  function purge() {
    deleteLeastRecentlyUsedEntries(0);
  }

  function setLimit(limit: number) {
    LIMIT = limit;
    scheduleCleanUp();
  }

  return {
    add,
    update,
    // delete: deleteEntry,
    access,
    purge,
    setLimit,
  };
}
