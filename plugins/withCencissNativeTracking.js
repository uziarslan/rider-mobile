const fs = require('fs');
const path = require('path');
const {
  AndroidConfig,
  withAndroidManifest,
  withDangerousMod,
  withMainApplication,
} = require('expo/config-plugins');

const SERVICE_NAME = 'com.cenciss.rider.tracking.CencissTrackingService';

function withTrackingManifest(config) {
  return withAndroidManifest(config, (result) => {
    AndroidConfig.Permissions.ensurePermission(result.modResults, 'android.permission.WAKE_LOCK');
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(result.modResults);
    application.service = application.service || [];
    const existing = application.service.find((item) => item.$?.['android:name'] === SERVICE_NAME);
    const attributes = {
      'android:name': SERVICE_NAME,
      'android:enabled': 'true',
      'android:exported': 'false',
      'android:foregroundServiceType': 'location',
      'android:stopWithTask': 'false',
    };
    if (existing) existing.$ = {...existing.$, ...attributes};
    else application.service.push({$: attributes});
    return result;
  });
}

function withTrackingPackageRegistration(config) {
  return withMainApplication(config, (result) => {
    let source = result.modResults.contents;
    const packageImport = 'import com.cenciss.rider.tracking.CencissTrackingPackage';
    if (!source.includes(packageImport)) {
      const lastImport = [...source.matchAll(/^import .*$/gm)].pop();
      if (!lastImport) throw new Error('Could not locate MainApplication imports for Cenciss tracking.');
      const insertAt = lastImport.index + lastImport[0].length;
      source = `${source.slice(0, insertAt)}\n${packageImport}${source.slice(insertAt)}`;
    }
    if (!source.includes('add(CencissTrackingPackage())')) {
      const marker = '// add(MyReactNativePackage())';
      if (!source.includes(marker)) throw new Error('Could not locate the ReactPackage registration block.');
      source = source.replace(marker, `${marker}\n              add(CencissTrackingPackage())`);
    }
    result.modResults.contents = source;
    return result;
  });
}

function withTrackingNativeSources(config) {
  return withDangerousMod(config, ['android', async (result) => {
    const projectRoot = result.modRequest.projectRoot;
    const sourceDirectory = path.join(projectRoot, 'native', 'android');
    const targetDirectory = path.join(
      projectRoot,
      'android',
      'app',
      'src',
      'main',
      'java',
      'com',
      'cenciss',
      'rider',
      'tracking',
    );
    fs.mkdirSync(targetDirectory, {recursive: true});
    for (const filename of fs.readdirSync(sourceDirectory).filter((name) => name.endsWith('.kt'))) {
      fs.copyFileSync(path.join(sourceDirectory, filename), path.join(targetDirectory, filename));
    }
    return result;
  }]);
}

module.exports = function withCencissNativeTracking(config) {
  config = withTrackingManifest(config);
  config = withTrackingPackageRegistration(config);
  config = withTrackingNativeSources(config);
  return config;
};
