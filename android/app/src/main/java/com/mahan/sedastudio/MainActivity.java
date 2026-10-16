package com.mahan.sedastudio;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AudioSaverPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
