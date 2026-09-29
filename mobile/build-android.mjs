// Builds a debug APK; with --install it also installs and launches it on the attached Android device.
// ANDROID_SERIAL picks a device when several are attached. JAVA_HOME / ANDROID_HOME default to the macOS installs.
import {execFileSync} from 'node:child_process';
import {mkdirSync, copyFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const env={...process.env};
if(!env.JAVA_HOME&&process.platform==='darwin')env.JAVA_HOME=execFileSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).trim();
if(!env.ANDROID_HOME&&process.platform==='darwin')env.ANDROID_HOME=resolve(process.env.HOME,'Library/Android/sdk');
const run=(cmd,args,cwd=root)=>execFileSync(cmd,args,{cwd,env,stdio:'inherit'});

run('npm',['run','build']);
run('npx',['cap','sync','android']);
run('./gradlew',['assembleDebug','--console=plain','-q'],resolve(root,'android'));
const apk=resolve(root,'mobile/out/bobo-debug.apk');
mkdirSync(resolve(root,'mobile/out'),{recursive:true});
copyFileSync(resolve(root,'android/app/build/outputs/apk/debug/app-debug.apk'),apk);
console.log(`APK: ${apk}`);

if(process.argv.includes('--install')){
  const serial=process.env.ANDROID_SERIAL??firstDevice();
  run('adb',['-s',serial,'install','-r',apk]);
  run('adb',['-s',serial,'shell','am','start','-n','com.polats.bobo/.MainActivity']);
}

function firstDevice(){
  const devices=execFileSync('adb',['devices'],{encoding:'utf8',env}).split('\n').filter((l)=>/\tdevice$/.test(l)).map((l)=>l.split('\t')[0]);
  if(!devices.length)throw Error('No Android device attached (adb devices)');
  if(devices.length>1)throw Error('Several devices attached; set ANDROID_SERIAL');
  return devices[0];
}
