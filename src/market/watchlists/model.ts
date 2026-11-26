import { z } from "zod";

export const WATCH_SORTS = [
  "added",
  "az",
  "change",
  "ltp",
  "exchange",
] as const;
export type WatchSort = (typeof WATCH_SORTS)[number];

const WatchGroupSchema = z.object({ id: z.string(), name: z.string() });
/** Keeps every well-formed group record and drops only the malformed ones; a non-array is no groups. */
const TolerantGroups = z
  .array(z.unknown())
  .catch([])
  .transform((rows) =>
    rows.flatMap((r) => {
      const g = WatchGroupSchema.safeParse(r);
      return g.success ? [g.data] : [];
    }),
  );
const WatchItemSchema = z.object({
  exchange: z.string(),
  symbol: z.string(),
  group: z.string().optional().catch(undefined),
});
/** The 0.1.0 item: no group. */
const V1ItemSchema = z.object({ exchange: z.string(), symbol: z.string() });

/** The device-local watchlists (design 7.7). `version` lets a later release migrate the shape. */
const V2Schema = z.object({
  version: z.literal(2),
  /** The list the screen shows; absent in A-T21 documents, where the first list is active. */
  activeId: z.string().optional(),
  lists: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      items: z.array(WatchItemSchema),
      groups: TolerantGroups,
      sort: z.enum(WATCH_SORTS).catch("added"),
    }),
  ),
});

const V1Schema = z.object({
  version: z.literal(1),
  activeId: z.string().optional(),
  lists: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      items: z.array(V1ItemSchema),
    }),
  ),
});

export type WatchGroup = z.output<typeof WatchGroupSchema>;
export type WatchItem = z.output<typeof WatchItemSchema>;
export type Watchlists = z.output<typeof V2Schema>;
export type WatchList = Watchlists["lists"][number];

/** A 0.1.0 document keeps its ids, names, items and active list; it gains no groups and the added order. */
export function migrateV1(v1: z.output<typeof V1Schema>): Watchlists {
  return {
    version: 2,
    activeId: v1.activeId,
    lists: v1.lists.map((l) => ({ ...l, groups: [], sort: "added" as const })),
  };
}

export const WatchlistsSchema = z.union([
  V2Schema,
  V1Schema.transform(migrateV1),
]);

export const DEFAULT_WATCHLISTS: Watchlists = {
  version: 2,
  activeId: "default",
  lists: [
    {
      id: "default",
      name: "Watchlist",
      groups: [],
      sort: "added",
      items: [
        { exchange: "NSE", symbol: "RELIANCE" },
        { exchange: "NSE", symbol: "TCS" },
        { exchange: "NSE", symbol: "INFY" },
        { exchange: "NSE", symbol: "HDFCBANK" },
        { exchange: "NSE", symbol: "ICICIBANK" },
        { exchange: "NSE", symbol: "SBIN" },
        { exchange: "NSE_INDEX", symbol: "NIFTY" },
      ],
    },
  ],
};

export const WATCHLIST_LIMITS = {
  lists: 50,
  items: 250,
  groups: 20,
  nameMax: 30,
} as const;

/** Every reducer is pure: it returns the next document (the same object when nothing changed). */
export type Reduced<R> = { next: Watchlists; result: R };

const keep = <R>(w: Watchlists, result: R): Reduced<R> => ({ next: w, result });
const cleanName = (name: string): string | null => {
  const n = name.trim();
  return n.length > 0 && n.length <= WATCHLIST_LIMITS.nameMax ? n : null;
};
const mapList = (
  w: Watchlists,
  id: string,
  f: (items: WatchItem[]) => WatchItem[],
): Watchlists => ({
  ...w,
  lists: w.lists.map((l) => (l.id === id ? { ...l, items: f(l.items) } : l)),
});
const find = (w: Watchlists, id: string) => w.lists.find((l) => l.id === id);
const same = (a: WatchItem, b: WatchItem) =>
  a.exchange === b.exchange && a.symbol === b.symbol;

export function createList(
  w: Watchlists,
  name: string,
  id: string,
): Reduced<"ok" | "limit" | "bad_name"> {
  const n = cleanName(name);
  if (n === null) return keep(w, "bad_name");
  if (w.lists.length >= WATCHLIST_LIMITS.lists) return keep(w, "limit");
  return {
    next: {
      ...w,
      lists: [
        ...w.lists,
        { id, name: n, items: [], groups: [], sort: "added" },
      ],
    },
    result: "ok",
  };
}

export function renameList(
  w: Watchlists,
  id: string,
  name: string,
): Reduced<"ok" | "bad_name" | "missing"> {
  const n = cleanName(name);
  if (n === null) return keep(w, "bad_name");
  if (!find(w, id)) return keep(w, "missing");
  return {
    next: {
      ...w,
      lists: w.lists.map((l) => (l.id === id ? { ...l, name: n } : l)),
    },
    result: "ok",
  };
}

export function deleteList(
  w: Watchlists,
  id: string,
): Reduced<"ok" | "last_list" | "missing"> {
  if (!find(w, id)) return keep(w, "missing");
  if (w.lists.length <= 1) return keep(w, "last_list");
  const lists = w.lists.filter((l) => l.id !== id);
  const activeId = w.activeId === id ? lists[0]?.id : w.activeId;
  return { next: { ...w, lists, activeId }, result: "ok" };
}

export function addItem(
  w: Watchlists,
  listId: string,
  item: WatchItem,
): Reduced<"added" | "duplicate" | "full" | "missing"> {
  const list = find(w, listId);
  if (!list) return keep(w, "missing");
  if (list.items.some((i) => same(i, item))) return keep(w, "duplicate");
  if (list.items.length >= WATCHLIST_LIMITS.items) return keep(w, "full");
  const row = { exchange: item.exchange, symbol: item.symbol };
  return {
    next: mapList(w, listId, (items) => [...items, row]),
    result: "added",
  };
}

export function removeItem(
  w: Watchlists,
  listId: string,
  item: WatchItem,
): Reduced<"ok" | "missing"> {
  const list = find(w, listId);
  if (!list?.items.some((i) => same(i, item))) return keep(w, "missing");
  return {
    next: mapList(w, listId, (items) => items.filter((i) => !same(i, item))),
    result: "ok",
  };
}

export function moveItem(
  w: Watchlists,
  listId: string,
  from: number,
  to: number,
): Reduced<"ok" | "bad_index" | "missing"> {
  const list = find(w, listId);
  if (!list) return keep(w, "missing");
  const n = list.items.length;
  const ok = (i: number) => Number.isInteger(i) && i >= 0 && i < n;
  if (!ok(from) || !ok(to)) return keep(w, "bad_index");
  if (from === to) return keep(w, "ok");
  return {
    next: mapList(w, listId, (items) => {
      const rows = [...items];
      const [moved] = rows.splice(from, 1);
      if (moved) rows.splice(to, 0, moved);
      return rows;
    }),
    result: "ok",
  };
}

export function setActive(
  w: Watchlists,
  id: string,
): Reduced<"ok" | "missing"> {
  if (!find(w, id)) return keep(w, "missing");
  return { next: { ...w, activeId: id }, result: "ok" };
}

const mapOne = (
  w: Watchlists,
  id: string,
  f: (l: WatchList) => WatchList,
): Watchlists => ({
  ...w,
  lists: w.lists.map((l) => (l.id === id ? f(l) : l)),
});

export function createGroup(
  w: Watchlists,
  listId: string,
  name: string,
  id: string,
): Reduced<"ok" | "bad_name" | "limit" | "missing"> {
  const list = find(w, listId);
  if (!list) return keep(w, "missing");
  const n = cleanName(name);
  if (n === null) return keep(w, "bad_name");
  if (list.groups.length >= WATCHLIST_LIMITS.groups) return keep(w, "limit");
  return {
    next: mapOne(w, listId, (l) => ({
      ...l,
      groups: [...l.groups, { id, name: n }],
    })),
    result: "ok",
  };
}

export function renameGroup(
  w: Watchlists,
  listId: string,
  groupId: string,
  name: string,
): Reduced<"ok" | "bad_name" | "missing"> {
  const list = find(w, listId);
  if (!list?.groups.some((g) => g.id === groupId)) return keep(w, "missing");
  const n = cleanName(name);
  if (n === null) return keep(w, "bad_name");
  return {
    next: mapOne(w, listId, (l) => ({
      ...l,
      groups: l.groups.map((g) => (g.id === groupId ? { ...g, name: n } : g)),
    })),
    result: "ok",
  };
}

/** The group goes; its items stay where they are, ungrouped. */
export function deleteGroup(
  w: Watchlists,
  listId: string,
  groupId: string,
): Reduced<"ok" | "missing"> {
  const list = find(w, listId);
  if (!list?.groups.some((g) => g.id === groupId)) return keep(w, "missing");
  return {
    next: mapOne(w, listId, (l) => ({
      ...l,
      groups: l.groups.filter((g) => g.id !== groupId),
      items: l.items.map((i) =>
        i.group === groupId ? { exchange: i.exchange, symbol: i.symbol } : i,
      ),
    })),
    result: "ok",
  };
}

export function moveGroup(
  w: Watchlists,
  listId: string,
  groupId: string,
  by: -1 | 1,
): Reduced<"ok" | "bad_index" | "missing"> {
  const list = find(w, listId);
  const from = list?.groups.findIndex((g) => g.id === groupId) ?? -1;
  if (!list || from < 0) return keep(w, "missing");
  const to = from + by;
  if (to < 0 || to >= list.groups.length) return keep(w, "bad_index");
  return {
    next: mapOne(w, listId, (l) => {
      const groups = [...l.groups];
      const a = groups[from];
      const b = groups[to];
      if (a && b) {
        groups[from] = b;
        groups[to] = a;
      }
      return { ...l, groups };
    }),
    result: "ok",
  };
}

/** The item moves to the end of `items` with its new group (null: ungrouped). */
export function setItemGroup(
  w: Watchlists,
  listId: string,
  item: WatchItem,
  groupId: string | null,
): Reduced<"ok" | "missing"> {
  const list = find(w, listId);
  if (!list?.items.some((i) => same(i, item))) return keep(w, "missing");
  if (groupId !== null && !list.groups.some((g) => g.id === groupId))
    return keep(w, "missing");
  const row: WatchItem =
    groupId === null
      ? { exchange: item.exchange, symbol: item.symbol }
      : { exchange: item.exchange, symbol: item.symbol, group: groupId };
  return {
    next: mapList(w, listId, (items) => [
      ...items.filter((i) => !same(i, item)),
      row,
    ]),
    result: "ok",
  };
}

/** Swaps the item with the nearest item of its own group in that direction. */
export function moveItemInGroup(
  w: Watchlists,
  listId: string,
  item: WatchItem,
  by: -1 | 1,
): Reduced<"ok" | "bad_index" | "missing"> {
  const list = find(w, listId);
  const from = list?.items.findIndex((i) => same(i, item)) ?? -1;
  if (!list || from < 0) return keep(w, "missing");
  const group = list.items[from]?.group;
  let to = from + by;
  while (to >= 0 && to < list.items.length && list.items[to]?.group !== group)
    to += by;
  if (to < 0 || to >= list.items.length) return keep(w, "bad_index");
  return {
    next: mapList(w, listId, (items) => {
      const rows = [...items];
      const a = rows[from];
      const b = rows[to];
      if (a && b) {
        rows[from] = b;
        rows[to] = a;
      }
      return rows;
    }),
    result: "ok",
  };
}

export function moveList(
  w: Watchlists,
  listId: string,
  by: -1 | 1,
): Reduced<"ok" | "bad_index" | "missing"> {
  const from = w.lists.findIndex((l) => l.id === listId);
  if (from < 0) return keep(w, "missing");
  const to = from + by;
  if (to < 0 || to >= w.lists.length) return keep(w, "bad_index");
  const lists = [...w.lists];
  const a = lists[from];
  const b = lists[to];
  if (a && b) {
    lists[from] = b;
    lists[to] = a;
  }
  return { next: { ...w, lists }, result: "ok" };
}

export function setSort(
  w: Watchlists,
  listId: string,
  sort: WatchSort,
): Reduced<"ok" | "missing"> {
  if (!find(w, listId)) return keep(w, "missing");
  return { next: mapOne(w, listId, (l) => ({ ...l, sort })), result: "ok" };
}
