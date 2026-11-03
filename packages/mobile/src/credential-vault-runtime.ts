import * as SecureStore from "expo-secure-store";
import { IOS_KEYCHAIN_ACCESS_GROUP } from "./config";
import { CredentialVault } from "@rome-os/libs/native-auth";

const options: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  keychainService: "cc.romeos.mobile.credentials",
  ...(IOS_KEYCHAIN_ACCESS_GROUP ? { accessGroup: IOS_KEYCHAIN_ACCESS_GROUP } : {}),
};

export const credentialVault = new CredentialVault({
  getItem(key) {
    return SecureStore.getItemAsync(key, options);
  },
  setItem(key, value) {
    return SecureStore.setItemAsync(key, value, options);
  },
  deleteItem(key) {
    return SecureStore.deleteItemAsync(key, options);
  },
});
