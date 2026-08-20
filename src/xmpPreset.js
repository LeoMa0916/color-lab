const IDENTITY_CURVE = [{ x: 0, y: 0 }, { x: 255, y: 255 }];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function xmpCurve(points) {
  return (points || IDENTITY_CURVE)
    .map((point) => `<rdf:li>${Math.round(point.x)}, ${Math.round(point.y)}</rdf:li>`)
    .join("");
}

export function xmpPreset(settings, name) {
  const value = (key) => settings[key] ?? 0;
  const curves = settings.curves || {};
  const incrementalTemperature = Math.round(clamp(value("temperature"), -100, 100));
  const incrementalTint = Math.round(clamp(value("tint"), -100, 100));
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      crs:PresetType="Normal" crs:Name="${xmlEscape(name)}" crs:Version="15.4"
      crs:ProcessVersion="15.4" crs:HasSettings="True"
      crs:WhiteBalance="As Shot"
      crs:IncrementalTemperature="${incrementalTemperature}"
      crs:IncrementalTint="${incrementalTint}"
      crs:Exposure2012="${value("exposure")}" crs:Contrast2012="${value("contrast")}"
      crs:Highlights2012="${value("highlights")}" crs:Shadows2012="${value("shadows")}"
      crs:Whites2012="${value("whites")}" crs:Blacks2012="${value("blacks")}"
      crs:Texture="${value("texture")}" crs:Clarity2012="${value("clarity")}"
      crs:Dehaze="${value("dehaze")}" crs:Vibrance="${value("vibrance")}"
      crs:Saturation="${value("saturation")}" crs:GrainAmount="${value("grain")}"
      crs:GrainSize="${clamp(Math.round(value("grainSize") * 25), 0, 100)}"
      crs:GrainFrequency="${clamp(Math.round(value("grainRoughness")), 0, 100)}"
      crs:ToneCurveName2012="Custom">
      <crs:ToneCurvePV2012><rdf:Seq>${xmpCurve(curves.master)}</rdf:Seq></crs:ToneCurvePV2012>
      <crs:ToneCurvePV2012Red><rdf:Seq>${xmpCurve(curves.red)}</rdf:Seq></crs:ToneCurvePV2012Red>
      <crs:ToneCurvePV2012Green><rdf:Seq>${xmpCurve(curves.green)}</rdf:Seq></crs:ToneCurvePV2012Green>
      <crs:ToneCurvePV2012Blue><rdf:Seq>${xmpCurve(curves.blue)}</rdf:Seq></crs:ToneCurvePV2012Blue>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}
