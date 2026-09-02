import {
  type AppPlatform,
  type AppUpdatePolicy,
  handleAppUpdatePolicy,
} from "./handler.ts";

function environmentPolicy(platform: AppPlatform): AppUpdatePolicy | undefined {
  const prefix = `APP_UPDATE_${platform.toUpperCase()}`;
  const minimumSupportedVersion = Deno.env.get(
    `${prefix}_MINIMUM_SUPPORTED_VERSION`,
  )?.trim();
  const storeUrl = Deno.env.get(`${prefix}_STORE_URL`)?.trim();

  if (!minimumSupportedVersion && !storeUrl) return undefined;
  return {
    minimumSupportedVersion: minimumSupportedVersion ?? "",
    storeUrl: storeUrl ?? "",
  };
}

Deno.serve((request) =>
  handleAppUpdatePolicy(request, {
    policies: {
      ios: environmentPolicy("ios"),
      android: environmentPolicy("android"),
    },
    log: (entry) => console.info(JSON.stringify(entry)),
  })
);
