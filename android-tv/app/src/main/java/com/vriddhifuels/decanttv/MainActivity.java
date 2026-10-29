package com.vriddhifuels.decanttv;

import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * The decant app (GitHub Pages) full screen on an Android TV, in its TV
 * mode (?tv=1: bigger, and the remote's arrow keys move a highlight). The
 * app itself is the web page: updates to it need no new APK.
 */
public class MainActivity extends Activity {
    static final String HOST = "subhamkhetan-ux.github.io";
    static final String START = "https://" + HOST + "/Vriddhi-Fuels-Website/decant/?tv=1";

    // Back: an open sheet closes (the app closes it on Escape), else the page before, else the app.
    static final String CLOSE_SHEET = "(function(){var s=Array.prototype.slice.call(document.querySelectorAll('.sheet'))"
            + ".filter(function(x){return !x.hidden;});if(!s.length)return '';"
            + "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return 'closed';})()";

    static final String OFFLINE = "<html><body style=\"background:#0a0706;color:#f5f0eb;font:22px sans-serif;"
            + "display:flex;align-items:center;justify-content:center;height:90vh;text-align:center\"><div>"
            + "<p>The decant app couldn't be reached.<br>Check the TV's internet.</p>"
            + "<button autofocus onclick=\"location.replace('" + START + "')\" style=\"font:22px sans-serif;"
            + "padding:14px 28px;border-radius:12px;border:3px solid #ff7a1a;background:#f4511e;color:#fff\">"
            + "Try again</button></div></body></html>";

    private WebView web;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);   // a screen to watch: it stays on
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // the app's own copy and the sign-in
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setUserAgentString(s.getUserAgentString() + " VriddhiDecantTV/1");
        CookieManager.getInstance().setAcceptCookie(true);

        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // only the app's own pages open here (a TV may have no browser for the rest)
                return !HOST.equals(request.getUrl().getHost());
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    view.loadDataWithBaseURL(START, OFFLINE, "text/html", "utf-8", null);
                }
            }
        });

        if (state != null) {
            web.restoreState(state);
        } else {
            web.loadUrl(START);
        }
        web.requestFocus();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getKeyCode() == KeyEvent.KEYCODE_BACK) {
            if (event.getAction() == KeyEvent.ACTION_UP) {
                web.evaluateJavascript(CLOSE_SHEET, result -> {
                    if (result != null && result.contains("closed")) {
                        return;
                    }
                    if (web.canGoBack()) {
                        web.goBack();
                    } else {
                        finish();
                    }
                });
            }
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onPause() {
        CookieManager.getInstance().flush();
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
