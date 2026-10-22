import { app } from 'electron'

export function getApplicationVersion(): string {
  if (!app.isPackaged && process.env.npm_package_version) return process.env.npm_package_version
  return app.getVersion()
}
