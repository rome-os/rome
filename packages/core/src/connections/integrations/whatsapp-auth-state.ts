// A custom Baileys auth state backed by an in-memory record with
// `kit.persist` write-through, replacing Baileys' `useMultiFileAuthState`.
//
// Baileys' `AuthenticationState` is `{ creds, keys }`: `creds` is the long-lived
// `AuthenticationCreds` object, `keys` is a `SignalKeyStore` (get/set over a
// category→id→value map that Baileys rotates on almost every frame). The stock
// multi-file store persists `creds` to `creds.json` and every key to its own
// `${category}-${id}.json`, all serialized with Baileys' `BufferJSON` so the
// binary `Uint8Array`/`Buffer` fields survive JSON.
//
// This module keeps the exact same shape in memory and folds the whole state
// into one credential material `{ creds, keys }` (two `BufferJSON` strings) that
// it hands to `kit.persist("session", …)` on every mutation. The registry stores
// that material in place — no epoch rebuild — so a restart rebuilds the identical
// live socket from the ledger, and `flush()` on stop guarantees the final state
// is never lost to the debounce.

import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import type { SecretRecord } from "../types.js";

/**
 * The serialized WhatsApp `session` grant material. Both fields are
 * `BufferJSON`-encoded JSON strings so binary key material survives a round trip
 * through the ledger's string-only {@link SecretRecord}.
 *   - `creds`: the `AuthenticationCreds` object.
 *   - `keys`:  the full signal key store as `{ [category]: { [id]: value } }`.
 */
export interface WhatsAppAuthMaterial extends SecretRecord {
  creds: string;
  keys: string;
}

/** A live auth state plus the write-through hooks the adapter/tests drive. */
export interface WhatsAppAuthStateHandle {
  /** The Baileys state to build a socket over. */
  readonly state: AuthenticationState;
  /** Called by the adapter on every `creds.update` — schedules a debounced
   *  write-through of the current (creds+keys) material. */
  saveCreds(): Promise<void>;
  /** The current material, freshly serialized. */
  serialize(): WhatsAppAuthMaterial;
  /** Force any pending debounced write immediately and await it. Called on
   *  `stop()` so the final rotation is never dropped. */
  flush(): Promise<void>;
}

/** A category→id→value map, the in-memory backing store for the SignalKeyStore. */
type KeyStoreRecord = {
  [C in keyof SignalDataTypeMap]?: { [id: string]: SignalDataTypeMap[C] | null };
};

/**
 * Build a live in-memory auth state from serialized material (or a fresh
 * `initAuthCreds()` when `material` is null — a brand-new pairing).
 *
 * `persist` is the write-through: every `keys.set` and `saveCreds()` schedules a
 * `persist(serialize())` on the next microtask, so a burst of key rotations
 * within one tick collapses to a single write while the FINAL state is always
 * the one persisted. `flush()` awaits any scheduled write.
 */
export function createWhatsAppAuthState(
  material: WhatsAppAuthMaterial | null,
  persist: (material: WhatsAppAuthMaterial) => Promise<void>,
): WhatsAppAuthStateHandle {
  const creds: AuthenticationCreds = material
    ? (JSON.parse(material.creds, BufferJSON.reviver) as AuthenticationCreds)
    : initAuthCreds();
  const keys: KeyStoreRecord = material
    ? (JSON.parse(material.keys, BufferJSON.reviver) as KeyStoreRecord)
    : {};

  const serialize = (): WhatsAppAuthMaterial => ({
    creds: JSON.stringify(creds, BufferJSON.replacer),
    keys: JSON.stringify(keys, BufferJSON.replacer),
  });

  // Debounce: coalesce a burst of rotations into one write per tick without ever
  // dropping the final state. `pending` is the in-flight scheduled write.
  let scheduled = false;
  let pending: Promise<void> | null = null;
  const schedule = (): Promise<void> => {
    if (!scheduled) {
      scheduled = true;
      pending = Promise.resolve().then(() => {
        scheduled = false;
        // Serialize at write time, so the coalesced write carries the LATEST
        // creds+keys, not the snapshot from when the first mutation scheduled.
        return persist(serialize());
      });
    }
    return pending!;
  };

  const state: AuthenticationState = {
    creds,
    keys: {
      async get(type, ids) {
        const bucket = keys[type] as Record<string, unknown> | undefined;
        const out: Record<string, unknown> = {};
        for (const id of ids) {
          let value = bucket?.[id];
          if (value == null) continue;
          // Mirror useMultiFileAuthState: app-state-sync-key values must be
          // rehydrated back into their proto message wrapper.
          if (type === "app-state-sync-key") {
            value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
          }
          out[id] = value;
        }
        return out as { [id: string]: SignalDataTypeMap[typeof type] };
      },
      set(data) {
        for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
          const bucket = ((keys as Record<string, Record<string, unknown>>)[category] ??= {});
          const incoming = data[category] as Record<string, unknown> | undefined;
          if (!incoming) continue;
          for (const id of Object.keys(incoming)) {
            const value = incoming[id];
            if (value == null) {
              delete bucket[id];
            } else {
              bucket[id] = value;
            }
          }
        }
        return schedule();
      },
    },
  };

  return {
    state,
    saveCreds: () => schedule(),
    serialize,
    // Drain, don't just await the captured write: a key rotation can schedule a
    // NEW write while the captured one is in flight, and stop() must not lose it.
    flush: async () => {
      let p = pending;
      while (p) {
        await p;
        p = pending !== p ? pending : null;
      }
    },
  };
}
