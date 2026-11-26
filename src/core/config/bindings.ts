import AsyncStorage from '@react-native-async-storage/async-storage'
import { createJSONStorage } from 'zustand/middleware'
import type { KV } from './storage'

/** Native bindings for the config layer: the only file here that touches AsyncStorage. */
export const asyncStorageKV: KV = {
  get: (key) => AsyncStorage.getItem(key),
  set: (key, value) => AsyncStorage.setItem(key, value),
  del: (key) => AsyncStorage.removeItem(key),
  async getMany(keys) {
    return (await AsyncStorage.multiGet(keys)).map(([, v]) => v)
  },
  async keys(prefix) {
    return (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(prefix))
  },
}

/** zustand persist adapter over AsyncStorage. */
export const persistStorage = createJSONStorage(() => AsyncStorage)
