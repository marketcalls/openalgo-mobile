import { QueryClient } from '@tanstack/react-query'
import { userEvent, waitFor } from '@testing-library/react-native'
import { Stack } from 'expo-router'
import { act, renderRouter, screen } from 'expo-router/testing-library'
import { Alert } from 'react-native'
import BackupRoute from '~/app/(app)/account/backup'
import { profileStorage } from '~/core/config/storage'
import { createOrderEventBus } from '~/core/realtime/orderEvents'
import { type Services, ServicesProvider } from '~/core/services/services'
import { TradingProvider } from '~/market/trading'
import type { Watchlists } from '~/market/watchlists/model'
import { memoryKV } from '../../../test/helpers/memoryKV'
import { BACKUP_KIND } from './format'
import { pickBackup, shareBackup } from './io'
import { BACKUP_COPY } from './screens/BackupScreen'

jest.mock('./io', () => ({ shareBackup: jest.fn(async () => {}), pickBackup: jest.fn() }))
jest.mock('~/core/platform/haptics', () => ({
  notifySuccess: jest.fn(),
  notifyWarning: jest.fn(),
  notifyError: jest.fn(),
  tapLight: jest.fn(),
}))

const pick = jest.mocked(pickBackup)
const share = jest.mocked(shareBackup)

const MINE: Watchlists = {
  version: 1,
  activeId: 'a',
  lists: [
    { id: 'a', name: 'Watchlist', items: [{ exchange: 'NSE', symbol: 'TCS' }] },
    { id: 'b', name: 'Options', items: [] },
  ],
}
const FILE = {
  version: 1,
  lists: [
    { id: 'x', name: 'Options', items: [{ exchange: 'NSE', symbol: 'SBIN' }] },
    {
      id: 'y',
      name: 'Banks',
      items: [
        { exchange: 'NSE', symbol: 'HDFCBANK' },
        { exchange: 'NSE', symbol: 'ICICIBANK' },
      ],
    },
  ],
}
const backupText = (content: unknown = { watchlists: FILE }, schema = 1) =>
  JSON.stringify({ kind: BACKUP_KIND, schema, createdAt: 't', appVersion: '1', content })

let kv: ReturnType<typeof memoryKV>
let services: Services

function Layout() {
  return (
    <ServicesProvider value={services}>
      <TradingProvider now={Date.now}>
        <Stack />
      </TradingProvider>
    </ServicesProvider>
  )
}
const saved = () => JSON.parse(kv.data.get('oa.p1.watchlists') ?? 'null') as Watchlists

async function open() {
  kv = memoryKV({ 'oa.p1.watchlists': JSON.stringify(MINE) })
  services = {
    api: { call: jest.fn() },
    storage: profileStorage(kv, 'p1'),
    profile: { get: () => ({ id: 'p1' }) },
    queryClient: new QueryClient(),
    orderEvents: createOrderEventBus(),
  } as unknown as Services
  await renderRouter({ _layout: Layout, index: BackupRoute }, { initialUrl: '/' })
  await screen.findByTestId('backup-create')
}

const choose = async (text: string | null) => {
  pick.mockResolvedValueOnce(text)
  await userEvent.press(screen.getByTestId('backup-restore'))
}

afterEach(() => jest.restoreAllMocks())

test('create builds the file from the lists and shares it under the IST name', async () => {
  await open()
  await userEvent.press(screen.getByTestId('backup-create'))
  await waitFor(() => expect(share).toHaveBeenCalledTimes(1))
  const [text, name] = share.mock.calls[0] ?? []
  expect(name).toMatch(/^openalgo-backup-\d{8}-\d{4}\.json$/)
  expect(JSON.parse(text ?? '').content.watchlists).toEqual(MINE)
})

test.each([
  ['too large', ' '.repeat(2_000_001), BACKUP_COPY.tooLarge],
  ['not a backup', '{}', BACKUP_COPY.notBackup],
])('%s: one plain sentence and nothing to restore', async (_n, text, copy) => {
  await open()
  await choose(text)
  expect(await screen.findByTestId('backup-error')).toHaveTextContent(copy)
  expect(screen.queryByTestId('restore-replace')).toBeNull()
  expect(saved()).toEqual(MINE)
})

test('cancelling the picker shows nothing', async () => {
  await open()
  await choose(null)
  expect(screen.queryByTestId('backup-found')).toBeNull()
  expect(screen.queryByTestId('backup-error')).toBeNull()
})

test('the file is summed up with its notes, and the lists stay until the confirm', async () => {
  await open()
  await choose(backupText({ watchlists: FILE, chartDrawings: { a: 1 } }, 2))
  expect(await screen.findByTestId('backup-summary')).toHaveTextContent('2 lists, 3 symbols')
  expect(screen.getByText(BACKUP_COPY.skipped(['chartDrawings']))).toBeOnTheScreen()
  expect(saved()).toEqual(MINE)

  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
  await userEvent.press(screen.getByTestId('restore-replace'))
  expect(alert.mock.calls[0]?.[0]).toBe('Replace your 2 watchlists?')
  expect(saved()).toEqual(MINE)

  // Cancel changes nothing
  const buttons = alert.mock.calls[0]?.[2] as { text: string; onPress: () => void }[]
  await act(async () => buttons[0]?.onPress())
  expect(saved()).toEqual(MINE)
  expect(screen.getByTestId('backup-found')).toBeOnTheScreen()
})

test('confirming Replace swaps the lists', async () => {
  await open()
  await choose(backupText())
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
  await userEvent.press(await screen.findByTestId('restore-replace'))
  const buttons = alert.mock.calls[0]?.[2] as { text: string; onPress: () => void }[]
  await act(async () => buttons[1]?.onPress())
  await waitFor(() => expect(saved().lists.map((l) => l.id)).toEqual(['x', 'y']))
  expect(screen.queryByTestId('backup-found')).toBeNull()
})

test('Merge appends and renames a clashing name, with no confirm', async () => {
  await open()
  await choose(backupText())
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
  await userEvent.press(await screen.findByTestId('restore-merge'))
  await waitFor(() =>
    expect(saved().lists.map((l) => l.name)).toEqual([
      'Watchlist',
      'Options',
      'Options (restored)',
      'Banks',
    ]),
  )
  expect(alert).not.toHaveBeenCalled()
})

test('a merge past 50 lists says how many were left out, not only "Backup restored"', async () => {
  await open()
  // 48 lists from the file beside the phone's 2: 46 fit, 2 are left out
  const lists = Array.from({ length: 50 }, (_, i) => ({ id: `l${i}`, name: `L${i}`, items: [] }))
  await choose(backupText({ watchlists: { version: 1, lists } }))
  await userEvent.press(await screen.findByTestId('restore-merge'))
  expect(await screen.findByText(BACKUP_COPY.leftOut(2))).toBeOnTheScreen()
  expect(BACKUP_COPY.leftOut(2)).toBe(
    'Backup restored. 2 lists were left out: a phone holds at most 50 lists.',
  )
  expect(saved().lists).toHaveLength(50)
})

test('the trimmed note reads as the plan says', async () => {
  await open()
  const lists = Array.from({ length: 60 }, (_, i) => ({ id: `l${i}`, name: `L${i}`, items: [] }))
  await choose(backupText({ watchlists: { version: 1, lists } }))
  expect(await screen.findByText(BACKUP_COPY.trimmed(10))).toBeOnTheScreen()
  expect(BACKUP_COPY.trimmed(10)).toBe('10 entries were over the limits and were left out.')
})

test('the fixed sentences', () => {
  expect(BACKUP_COPY.tooLarge).toBe('This file is too large to be an OpenAlgo backup.')
  expect(BACKUP_COPY.notBackup).toBe("This isn't an OpenAlgo Mobile backup file.")
  expect(BACKUP_COPY.skipped(['a', 'b'])).toBe("Skipped data this version can't read: a, b.")
})
