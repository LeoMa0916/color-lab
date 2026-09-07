package top.colorslab.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.List;

/** Visible recovery entry: never leave an OEM browser handoff behind a transparent activity. */
public class StartupActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private TextView status;
    private boolean attempted;
    private boolean departed;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setGravity(Gravity.CENTER);
        int padding = (int) (24 * getResources().getDisplayMetrics().density);
        layout.setPadding(padding, padding, padding, padding);
        layout.setBackgroundColor(0xff111722);
        layout.setFitsSystemWindows(true);
        TextView title = new TextView(this);
        title.setText("调色室"); title.setTextSize(28); title.setTextColor(0xffffffff);
        layout.addView(title);
        status = new TextView(this);
        status.setText("正在打开调色室…"); status.setTextSize(16);
        status.setTextColor(0xffd3dae7); status.setPadding(0, padding, 0, padding);
        layout.addView(status);
        Button browser = new Button(this);
        browser.setText("用浏览器继续");
        browser.setOnClickListener(view -> openBrowser());
        layout.addView(browser);
        Button retry = new Button(this);
        retry.setText("重试 App 模式");
        retry.setOnClickListener(view -> launchApp());
        layout.addView(retry);
        setContentView(layout);
        attempted = state != null && state.getBoolean("attempted");
        if (!attempted) handler.post(this::launchApp);
        else status.setText("如果 App 模式未能显示，请用浏览器继续。照片不会被清除。");
    }

    private void launchApp() {
        handler.removeCallbacksAndMessages(null);
        attempted = true;
        departed = false;
        status.setText("正在连接浏览器。若没有显示，请返回此页使用兼容入口。");
        try {
            // For-result keeps a visible recovery screen after a cancelled/failed handoff.
            startActivityForResult(new Intent(this,
                com.google.androidbrowserhelper.trusted.LauncherActivity.class), 10);
            handler.postDelayed(() -> {
                if (!departed && !isFinishing()) {
                    finishActivity(10);
                    status.setText("启动等待超时。请点“用浏览器继续”，无需安装 Chrome。");
                }
            }, 8000);
        } catch (RuntimeException exception) {
            status.setText("App 模式启动失败。请用浏览器继续。");
        }
    }

    private void openBrowser() {
        Intent query = new Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com"));
        query.addCategory(Intent.CATEGORY_BROWSABLE);
        List<ResolveInfo> resolved = getPackageManager().queryIntentActivities(query, 0);
        List<String> packages = new ArrayList<>();
        List<String> names = new ArrayList<>();
        for (ResolveInfo item : resolved) {
            String name = item.activityInfo.packageName;
            if (!name.equals(getPackageName()) && !packages.contains(name)) {
                packages.add(name);
                names.add(item.loadLabel(getPackageManager()).toString());
            }
        }
        if (packages.isEmpty()) {
            status.setText("未找到可用浏览器，请在系统浏览器中访问 https://colorslab.top");
            return;
        }
        if (packages.size() == 1) openPackage(packages.get(0));
        else new AlertDialog.Builder(this).setTitle("选择浏览器继续调色")
            .setItems(names.toArray(new String[0]), (dialog, which) -> openPackage(packages.get(which)))
            .setNegativeButton("取消", null).show();
    }

    private void openPackage(String name) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse("https://colorslab.top"));
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        intent.setPackage(name); // Explicit browser avoids resolving back into this app.
        try { startActivity(intent); }
        catch (RuntimeException exception) { status.setText("浏览器未能打开，请换一个浏览器重试。"); }
    }

    @Override protected void onStop() { super.onStop(); departed = true; }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == 10) status.setText("若刚才未显示页面，请点“用浏览器继续”。兼容模式会打开浏览器。");
    }
    @Override protected void onSaveInstanceState(Bundle state) {
        state.putBoolean("attempted", attempted); super.onSaveInstanceState(state);
    }
    @Override protected void onDestroy() { handler.removeCallbacksAndMessages(null); super.onDestroy(); }
}
