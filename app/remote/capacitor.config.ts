import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.mybuddy.remote',
  appName: 'Mybuddy',
  webDir: 'dist',
  android: { allowMixedContent: true },
}

export default config
