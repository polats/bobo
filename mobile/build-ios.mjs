// Builds a signed Debug iOS app; with --install it also installs and launches it on the attached iPhone.
// IOS_TEAM_ID overrides the team read from the development certificate; IOS_DEVICE picks a device.
import {execFileSync} from 'node:child_process';

const run=(cmd,args)=>execFileSync(cmd,args,{stdio:'inherit'});
const read=(cmd,args)=>execFileSync(cmd,args,{encoding:'utf8'});

run('npm',['run','build']);
run('npx',['cap','sync','ios']);

const identities=read('security',['find-identity','-v','-p','codesigning']);
const name=identities.match(/"(Apple Development:[^"]+)"/)?.[1];
if(!name)throw Error('No Apple Development signing identity available');
const certificate=execFileSync('security',['find-certificate','-c',name,'-p']);
const subject=execFileSync('openssl',['x509','-noout','-subject'],{input:certificate,encoding:'utf8'});
const team=process.env.IOS_TEAM_ID??subject.match(/OU\s*=\s*([A-Z0-9]+)/)?.[1];
if(!team)throw Error('Cannot determine signing team');

run('xcodebuild',['-project','ios/App/App.xcodeproj','-scheme','App','-configuration','Debug','-sdk','iphoneos','-destination','generic/platform=iOS','-derivedDataPath','mobile/out/ios','-allowProvisioningUpdates',`DEVELOPMENT_TEAM=${team}`,'CODE_SIGN_STYLE=Automatic','-quiet','build']);
const app='mobile/out/ios/Build/Products/Debug-iphoneos/App.app';
console.log(`iPhone build: ${app}`);

if(process.argv.includes('--install')){
  const device=process.env.IOS_DEVICE??firstPhysicalIphone();
  const ctl=(args)=>console.log(read('xcrun',['devicectl',...args]));
  ctl(['device','install','app','--device',device,app]);
  ctl(['device','process','launch','--terminate-existing','--device',device,'com.polats.bobo']);
}

function firstPhysicalIphone(){
  const out=read('xcrun',['devicectl','list','devices']);
  const line=out.split('\n').find((l)=>/iPhone/.test(l)&&/physical/.test(l)&&/available|connected/.test(l));
  const id=line?.match(/[0-9A-F]{8}-[0-9A-F]{16}|[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/)?.[0];
  if(!id)throw Error('No attached iPhone found; set IOS_DEVICE');
  return id;
}
