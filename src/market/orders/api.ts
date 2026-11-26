// Every order write and book read, each one Api.call with its C3 body and its reply schema.
// The options (a caller's abort signal) go through unchanged.
import type { Api } from '~/core/http/api'
import type { RequestOptions } from '~/core/http/client'
import {
  HoldingsSchema,
  OrderbookSchema,
  type OrderRow,
  PositionbookSchema,
  TradebookSchema,
} from '../books/schemas'
import type { Strategy } from '../types'
import {
  CancelAllReplySchema,
  CloseAllReplySchema,
  cancelAllBody,
  cancelBody,
  closeAllBody,
  IdReplySchema,
  MarginSchema,
  type ModifyChange,
  marginBody,
  modifyBody,
  type OrderSpec,
  PlaceReplySchema,
  type PositionToClose,
  placeBody,
  SmartReplySchema,
  SplitReplySchema,
  smartCloseBody,
  splitBody,
} from './schemas'

/** The options of a write that can start on the chart: its strategy is a body field, not an option. */
type WriteOptions = RequestOptions & { strategy?: Strategy }

export function createOrderApi(api: Api) {
  return {
    place: (o: OrderSpec, opts?: RequestOptions) =>
      api.call('placeorder', placeBody(o), PlaceReplySchema, opts),
    split: (o: OrderSpec, size: number, opts?: RequestOptions) =>
      api.call('splitorder', splitBody(o, size), SplitReplySchema, opts),
    smartClose: (row: PositionToClose, { strategy, ...opts }: WriteOptions = {}) =>
      api.call('placesmartorder', smartCloseBody(row, strategy), SmartReplySchema, opts),
    modify: (row: OrderRow, change: ModifyChange, { strategy, ...opts }: WriteOptions = {}) =>
      api.call('modifyorder', modifyBody(row, change, strategy), IdReplySchema, opts),
    cancel: (orderid: string, { strategy, ...opts }: WriteOptions = {}) =>
      api.call('cancelorder', cancelBody(orderid, strategy), IdReplySchema, opts),
    cancelAll: (opts?: RequestOptions) =>
      api.call('cancelallorder', cancelAllBody(), CancelAllReplySchema, opts),
    closeAll: (opts?: RequestOptions) =>
      api.call('closeposition', closeAllBody(), CloseAllReplySchema, opts),
    margin: (o: OrderSpec, opts?: RequestOptions) =>
      api.call('margin', marginBody(o), MarginSchema, opts),
    orderbook: (opts?: RequestOptions) => api.call('orderbook', {}, OrderbookSchema, opts),
    tradebook: (opts?: RequestOptions) => api.call('tradebook', {}, TradebookSchema, opts),
    positionbook: (opts?: RequestOptions) => api.call('positionbook', {}, PositionbookSchema, opts),
    holdings: (opts?: RequestOptions) => api.call('holdings', {}, HoldingsSchema, opts),
  }
}

export type OrderApi = ReturnType<typeof createOrderApi>
