# Decanting on an Android TV (`android-tv/`)

A tiny Android TV app: a **Decanting** tile on the TV's home screen that opens
the decant app (`/decant/`, from GitHub Pages) full screen, in its **TV mode**
(`decant/js/tv.js`):

- bigger type and a wider page, for across a room;
- the remote: the arrow keys move an orange highlight between the things to
  tap, **OK** taps, **Back** closes an open sheet (or goes back, or leaves);
- the buttons that need a phone's camera or files are hidden;
- the screen stays on while it's open, and the sign-in is kept.

The app is the web page itself: every change to the decant app reaches the TV
with no new APK. Only a change here (`android-tv/`) needs one, and the
**Decanting TV app** workflow builds it and puts it at a link that stays the
same:

`https://github.com/subhamkhetan-ux/Vriddhi-Fuels-Website/releases/download/decant-tv/Decanting-TV.apk`

## Installing it on the TV (once)

1. On the TV, from the Google Play Store, install **Downloader** (by AFTVnews).
2. Allow it to install apps: Settings → Apps → Security & restrictions (or
   Privacy → Security) → **Unknown sources** → turn on **Downloader**.
3. Open Downloader, select the address box and enter the link above. To avoid
   typing it with the remote: copy it on your phone, and in the **Google TV**
   app on the phone use Remote → the keyboard icon → paste.
4. **Install**, then **Open**. Sign in with the decant app's email and password
   (the Google TV app's keyboard again).
5. The **Decanting** tile is now among the apps on the home screen. To move it
   into the favourites row: long-press it → **Add to favourites** (wording
   differs by TV).

**A newer APK** (rarely needed: only for a change here) is signed with the
workflow runner's own debug key, which differs from build to build, so the TV
won't install it over the old one: uninstall **Decanting** first (Settings →
Apps), install the new one, and sign in again.

To have each new APK install straight over the last instead, give the workflow
a key of your own, once, as two repository secrets (Settings → Secrets and
variables → Actions), never in the repo:

```sh
keytool -genkeypair -keystore tv.keystore -alias decant-tv -keyalg RSA -keysize 2048 \
        -validity 10950 -dname "CN=Decanting TV"          # choose a password
base64 -w0 tv.keystore                                   # -> secret TV_KEYSTORE_B64
                                                         # the password -> secret TV_KEYSTORE_PASSWORD
```

## Building it yourself

```sh
gradle -p android-tv assembleRelease      # needs the Android SDK (ANDROID_HOME)
# -> android-tv/app/build/outputs/apk/release/app-release.apk
```
