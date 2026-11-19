import { getShellTransport } from "@/lib/transport"

export interface EgoImportProfile {
  id: string
  name: string
  isDefault: boolean
}

export interface EgoImportSettings {
  sourceProfileId: string | null
  sourceProfileName: string | null
  allowAgentImport: boolean
}

export interface EgoImportResult {
  tabId: string
  status: "imported" | "unchanged" | "refused"
  cookiesImported: number
  storageImported: number
  skippedExpired: number
  error?: string
  note?: string
}

// 固定来源属于本机桌面设置；不能经远程 Transport 写到服务器。
export function browserEgoImportProfiles(): Promise<EgoImportProfile[]> {
  return getShellTransport().call<EgoImportProfile[]>(
    "browser_ego_import_profiles",
    {}
  )
}

export function browserEgoImportSettings(): Promise<EgoImportSettings> {
  return getShellTransport().call<EgoImportSettings>(
    "browser_ego_import_settings",
    {}
  )
}

export function browserSetEgoImportSettings(
  settings: EgoImportSettings
): Promise<EgoImportSettings> {
  return getShellTransport().call<EgoImportSettings>(
    "browser_set_ego_import_settings",
    { settings }
  )
}

export function browserImportEgoSession(
  tabId: string
): Promise<EgoImportResult> {
  return getShellTransport().call<EgoImportResult>(
    "browser_import_ego_session",
    { tabId }
  )
}
