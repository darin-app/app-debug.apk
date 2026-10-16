package com.mahan.sedastudio;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.OutputStream;

/**
 * ذخیره‌ی مستقیم فایل صوتی در پوشه‌ی Music/SedaStudio با MediaStore.
 * فایل تکه‌تکه (base64) از جاوااسکریپت می‌رسد تا حافظه پر نشود.
 * روی اندروید ۱۰ به بالا بدون هیچ مجوزی کار می‌کند.
 */
@CapacitorPlugin(name = "AudioSaver")
public class AudioSaverPlugin extends Plugin {

    private OutputStream out;
    private Uri uri;
    private String displayName;

    @PluginMethod
    public void begin(PluginCall call) {
        String name = call.getString("name");
        String mime = call.getString("mime");
        if (name == null || mime == null) {
            call.reject("bad arguments");
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("LEGACY");
            return;
        }
        try {
            discard();
            ContentResolver resolver = getContext().getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_MUSIC + "/SedaStudio");
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri created = resolver.insert(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, values);
            if (created == null) {
                call.reject("insert failed");
                return;
            }
            uri = created;
            displayName = name;
            out = resolver.openOutputStream(created);
            if (out == null) {
                discard();
                call.reject("open failed");
                return;
            }
            call.resolve();
        } catch (Exception e) {
            discard();
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void append(PluginCall call) {
        String data = call.getString("data");
        if (out == null || data == null) {
            call.reject("no open file");
            return;
        }
        try {
            out.write(Base64.decode(data, Base64.DEFAULT));
            call.resolve();
        } catch (Exception e) {
            discard();
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void finish(PluginCall call) {
        if (out == null || uri == null) {
            call.reject("no open file");
            return;
        }
        try {
            out.flush();
            out.close();
            out = null;
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.IS_PENDING, 0);
            getContext().getContentResolver().update(uri, values, null, null);
            JSObject res = new JSObject();
            res.put("uri", uri.toString());
            res.put("path", "Music/SedaStudio/" + displayName);
            uri = null;
            call.resolve(res);
        } catch (Exception e) {
            discard();
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void abort(PluginCall call) {
        discard();
        call.resolve();
    }

    private void discard() {
        try {
            if (out != null) out.close();
        } catch (Exception ignored) {
        }
        out = null;
        if (uri != null) {
            try {
                getContext().getContentResolver().delete(uri, null, null);
            } catch (Exception ignored) {
            }
            uri = null;
        }
    }
}
