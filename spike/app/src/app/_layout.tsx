// THROWAWAY SPIKE. Root layout: five native tabs, the always-on frame probe and
// HUD, and the shared tick feed.
import { DarkTheme, ThemeProvider } from 'expo-router';
import { NativeTabs } from 'expo-router/native-tabs';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Hud, UiFpsProbe } from '~/components/Hud';
import { markFirstRender } from '~/core/metrics';
import { startDefaultFeed } from '~/core/settings';

SplashScreen.preventAutoHideAsync();

const icon = require('../../assets/images/tabIcons/home.png');
const icon2 = require('../../assets/images/tabIcons/explore.png');

export default function RootLayout() {
  useEffect(() => {
    markFirstRender();
    SplashScreen.hideAsync();
    startDefaultFeed();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={DarkTheme}>
        <View style={{ flex: 1, backgroundColor: '#0b0f14' }}>
          <NativeTabs backgroundColor="#0b0f14" labelStyle={{ selected: { color: '#e6edf3' } }}>
            <NativeTabs.Trigger name="index">
              <NativeTabs.Trigger.Label>Watchlist</NativeTabs.Trigger.Label>
              <NativeTabs.Trigger.Icon src={icon} renderingMode="template" />
            </NativeTabs.Trigger>
            <NativeTabs.Trigger name="chain">
              <NativeTabs.Trigger.Label>Chain</NativeTabs.Trigger.Label>
              <NativeTabs.Trigger.Icon src={icon2} renderingMode="template" />
            </NativeTabs.Trigger>
            <NativeTabs.Trigger name="chart">
              <NativeTabs.Trigger.Label>Chart</NativeTabs.Trigger.Label>
              <NativeTabs.Trigger.Icon src={icon} renderingMode="template" />
            </NativeTabs.Trigger>
            <NativeTabs.Trigger name="tool">
              <NativeTabs.Trigger.Label>Tool</NativeTabs.Trigger.Label>
              <NativeTabs.Trigger.Icon src={icon2} renderingMode="template" />
            </NativeTabs.Trigger>
            <NativeTabs.Trigger name="results">
              <NativeTabs.Trigger.Label>Results</NativeTabs.Trigger.Label>
              <NativeTabs.Trigger.Icon src={icon} renderingMode="template" />
            </NativeTabs.Trigger>
          </NativeTabs>
          <UiFpsProbe />
          <Hud />
        </View>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
