#!/usr/bin/env python3
"""Build a .vsix without vsce (works on Node 18, kde vsce neběží).

.vsix je ZIP v OPC formátu: kořen [Content_Types].xml + extension.vsixmanifest,
plus složka extension/ se soubory rozšíření. Verzi a metadata čte z package.json.

Použití:  python3 scripts/build_vsix.py
Výstup:   claude-tools-<version>.vsix v kořeni repa
"""
import json
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
pkg = json.load(open(os.path.join(ROOT, 'package.json'), encoding='utf-8'))

name = pkg['name']
version = pkg['version']
publisher = pkg.get('publisher', 'local')
display = pkg.get('displayName', name)
desc = pkg.get('description', '')
engine = pkg.get('engines', {}).get('vscode', '*')
kinds = pkg.get('extensionKind', [])


def xml_escape(s):
    return (s.replace('&', '&amp;').replace('<', '&lt;')
            .replace('>', '&gt;').replace('"', '&quot;'))


CONTENT_TYPES = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="css" ContentType="text/css" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="svg" ContentType="image/svg+xml" />
  <Default Extension="ttf" ContentType="application/octet-stream" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
</Types>
"""

kind_prop = ''
if kinds:
    kind_prop = ('\n      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="%s" />'
                 % ','.join(kinds))

MANIFEST = """<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{name}" Version="{version}" Publisher="{publisher}" />
    <DisplayName>{display}</DisplayName>
    <Description xml:space="preserve">{desc}</Description>
    <Tags>claude,claude-code,ai</Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{engine}" />{kind_prop}
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
""".format(name=name, version=version, publisher=publisher,
           display=xml_escape(display), desc=xml_escape(desc),
           engine=engine, kind_prop=kind_prop)

# soubory rozšíření (kořenové + celá media/)
ext_files = ['package.json', 'extension.js', 'README.md']
if os.path.exists(os.path.join(ROOT, 'LICENSE')):
    ext_files.append('LICENSE')
for f in sorted(os.listdir(os.path.join(ROOT, 'media'))):
    ext_files.append('media/' + f)

out = os.path.join(ROOT, '%s-%s.vsix' % (name, version))
if os.path.exists(out):
    os.remove(out)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', CONTENT_TYPES)
    z.writestr('extension.vsixmanifest', MANIFEST)
    for f in ext_files:
        z.write(os.path.join(ROOT, f), 'extension/' + f)

print('wrote', os.path.basename(out), '(%d bytes)' % os.path.getsize(out))
for n in zipfile.ZipFile(out).namelist():
    print('  ', n)
