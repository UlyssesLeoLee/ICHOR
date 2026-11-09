/**
 * ATS-603: the smoke-test APP.
 *
 * WHY A REAL APP
 * --------------
 * The acceptance criterion of ATS-603 is that a Flow runs on a REAL
 * Android emulator: the app goes to the foreground, an element is tapped,
 * an element is asserted visible, and a screenshot is taken.
 *
 * A test that taps a system screen would prove less: the elements of the
 * launcher change with the device image and the system version, so a
 * smoke test against them would be a test of the device, not of the
 * runner. This app is a FIXTURE with a KNOWN screen:
 *
 *   * the first screen carries the text `ICHOR Smoke Home` and a button
 *     labelled `Open Details`;
 *   * tapping the button shows a second screen carrying `ICHOR Detail
 *     Screen` and the text `Payload: hello-from-ichor`.
 *
 * So the four step kinds are measured against facts that cannot drift:
 * the launcher can be in any state, this app is not.
 *
 * HOW IT IS BUILT
 * ---------------
 * With the SDK's own tools -- `aapt2` to link the resources, `javac` to
 * compile, `d8` to dex, `apksigner` to sign -- so the fixture needs no
 * Gradle, no network and no dependency. The build script is
 * `tools/ats603-probes/build-smoke-app.sh`.
 */
package com.ichor.smoke;

import android.app.Activity;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(48, 96, 48, 48);

        TextView title = new TextView(this);
        title.setText("ICHOR Smoke Home");
        title.setTextSize(24);
        title.setGravity(Gravity.CENTER);
        title.setContentDescription("ICHOR Smoke Home");
        root.addView(title);

        Button open = new Button(this);
        open.setText("Open Details");
        open.setContentDescription("Open Details");
        open.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showDetail();
            }
        });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = 48;
        root.addView(open, lp);

        TextView payload = new TextView(this);
        payload.setText("Payload: hello-from-ichor");
        payload.setContentDescription("Payload: hello-from-ichor");
        root.addView(payload);

        setContentView(root);
    }

    private void showDetail() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(48, 96, 48, 48);

        TextView title = new TextView(this);
        title.setText("ICHOR Detail Screen");
        title.setTextSize(24);
        title.setGravity(Gravity.CENTER);
        title.setContentDescription("ICHOR Detail Screen");
        root.addView(title);

        TextView body = new TextView(this);
        body.setText("Payload: hello-from-ichor");
        body.setContentDescription("Payload: hello-from-ichor");
        root.addView(body);

        setContentView(root);
    }
}
