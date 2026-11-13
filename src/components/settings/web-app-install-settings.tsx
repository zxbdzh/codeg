"use client"

import { Check, Download, Smartphone } from "lucide-react"
import { useTranslations } from "next-intl"
import { useWebAppInstall } from "@/components/providers/web-app-install-provider"
import { SettingsSection } from "@/components/shared/settings-section"
import { Button } from "@/components/ui/button"

export function WebAppInstallSettings() {
  const t = useTranslations("WebAppInstall")
  const app = useWebAppInstall()
  if (!app) return null

  return (
    <SettingsSection
      icon={Smartphone}
      title={t("title")}
      description={t("description")}
    >
      <div className="space-y-3 text-xs leading-5 text-muted-foreground">
        {app.installed ? (
          <p role="status" className="flex items-center gap-2 text-foreground">
            <Check className="size-4" aria-hidden />
            {t(app.standalone ? "standalone" : "installed")}
          </p>
        ) : !app.secure ? (
          <p>{t("httpsRequired")}</p>
        ) : (
          <>
            {(app.canInstall || app.status === "prompting") && (
              <Button
                variant="outline"
                className="h-10"
                disabled={app.status === "prompting"}
                onClick={() => void app.install()}
              >
                <Download className="size-4" aria-hidden />
                {t(app.status === "prompting" ? "installing" : "install")}
              </Button>
            )}
            {app.status === "error" && <p role="alert">{t("failed")}</p>}
            {app.status === "accepted" ? (
              <p role="status">{t("accepted")}</p>
            ) : !app.canInstall && app.status !== "prompting" ? (
              app.ios ? (
                <ol className="list-decimal space-y-1 pl-4">
                  <li>{t("iosOpen")}</li>
                  <li>{t("iosShare")}</li>
                  <li>{t("iosAdd")}</li>
                </ol>
              ) : (
                <p>{t("browserMenu")}</p>
              )
            ) : null}
          </>
        )}
        <p>{t("connection")}</p>
      </div>
    </SettingsSection>
  )
}
