/**
 * The Infosys Preparation roster, transcribed verbatim from the program brief that
 * created this feature — not from a file, per that brief's explicit instruction
 * ("IMPORT THE FOLLOWING ROSTER DIRECTLY FROM THIS PROMPT. DO NOT depend on a file
 * existing in the repository."). This *is* that file, committed so the import is
 * re-runnable and auditable, but it is transcribed data, not a live source — if the
 * roster changes, this file is edited and the import re-run; there is no sync-from-
 * spreadsheet step here the way `import-campus-roster.ts` has for a CSV.
 *
 * Every student starts with `leetcodeUsername: null` when genuinely new — see
 * `import-infosys-roster.ts` for what happens when the email matches an existing
 * `Student` row instead (their existing data, including any LeetCode handle from
 * Coding Hours, is never touched or blanked).
 *
 * Campus names are exactly as given in the brief. `VELS INSTITUTE OF SCIENCE` is
 * deliberately mapped (in `import-infosys-roster.ts`) to the existing Coding Hours
 * campus "Vels Institute of Science, Technology & Advanced Studies" rather than a new
 * row — confirmed against production, where 12 of these 19 emails already exist as
 * archived Coding Hours students at that exact campus.
 */
export interface InfosysRosterRow {
  email: string;
  /** Campus name exactly as given in the source roster. */
  campusName: string;
}

const CHITKARA = `
aman.agrawal@kalvium.community
chirag.sareen@kalvium.community
gouri.agarwal@kalvium.community
abhinandan.gupta@kalvium.community
kamakshi.pandoh@kalvium.community
shubham.thakur@kalvium.community
satyam.sharma@kalvium.community
swasti.mohanty@kalvium.community
diwanshu.baskota@kalvium.community
ananya.tewari@kalvium.community
`;

const JECRC = `
surya.p@kalvium.community
ansh.sharma@kalvium.community
nayan.kumarraj@kalvium.community
rishabh.j@kalvium.community
dhruv.k@kalvium.community
anuj.sahu@kalvium.community
darshan.s@kalvium.community
ishita.n@kalvium.community
janhavi.chauhan@kalvium.community
kritika.w@kalvium.community
manvesh.t@kalvium.community
manya.j@kalvium.community
hanshul.k@kalvium.community
devraj.patil@kalvium.community
aniket.g@kalvium.community
gouransh.v@kalvium.community
nitin.soni@kalvium.community
somuya.k@kalvium.community
`;

const KALASALINGAM = `
raahul.varma@kalvium.community
karthika.movva@kalvium.community
jatin.batchu@kalvium.community
mohana.gangisetti@kalvium.community
rishitha.n@kalvium.community
sahanashre.v@kalvium.community
prasanna.venkatesh@kalvium.community
vinay.reddy@kalvium.community
athithya.ramaa@kalvium.community
shivavarma.k@kalvium.community
mukilan.p@kalvium.community
poshika.m@kalvium.community
`;

const KALVIUM_DIRECT = `
kamalesh.a@kalvium.community
santhoshkumar.v@kalvium.community
harini.r@kalvium.community
balashnekithaa.s@kalvium.community
akash.ss@kalvium.community
melvin.kanna@kalvium.community
alwin.sunil@kalvium.community
sri.kishore@kalvium.community
guru.vedhanth@kalvium.community
aaryan.panda@kalvium.community
sabari.s@kalvium.community
anam.ashraf@kalvium.community
kowsika.devi@kalvium.community
naveen.a@kalvium.community
siva.ganesh.c@kalvium.community
kavin.s@kalvium.community
harshit.chandel@kalvium.community
velavan.sundharamoorthy@kalvium.community
mugilan.s@kalvium.community
mugunthan.s@kalvium.community
abraham.jeron@kalvium.community
`;

const LPU = `
manpreet.singh@kalvium.community
kprasath@kalvium.community
kumar.mohan@kalvium.community
mukund.madhav@kalvium.community
mohammed.yaseen@kalvium.community
harshavardhan.sr@kalvium.community
mohamed.fazil@kalvium.community
jason.william@kalvium.community
nivaash.thirupathy@kalvium.community
aditya.raj@kalvium.community
vamshi.krishna@kalvium.community
addarsh.kumar@kalvium.community
megha.wadhwa@kalvium.community
shivangi.jain@kalvium.community
subham.mohanta@kalvium.community
kusumanchi.yagna@kalvium.community
rajashree.guha@kalvium.community
vishnu.preetham@kalvium.community
sarvesh.perumal@kalvium.community
milan.sana@kalvium.community
aayush.arora@kalvium.community
gurpreet.singh@kalvium.community
abdul.qureshi@kalvium.community
arjun.kotha@kalvium.community
abhinav.rajesh@kalvium.community
rikhil.taneja@kalvium.community
sharugeshwaran.k@kalvium.community
arun.kumar@kalvium.community
pranshu.pandey@kalvium.community
jyotiranjan.sahoo@kalvium.community
sravan.teja@kalvium.community
kumar.shubham@kalvium.community
`;

const MUJ = `
aiman.singh@kalvium.community
adhiraj.singh@kalvium.community
anushka.bhatt@kalvium.community
kushi.nain@kalvium.community
abhishek.chaudhari@kalvium.community
yashvardhan.dadhich@kalvium.community
harshwardhan.dhoble@kalvium.community
aditi.vashishtha@kalvium.community
ayush.singh@kalvium.community
`;

const MITADT = `
arya.patil@kalvium.community
shreyas.wagh@kalvium.community
om.bankar@kalvium.community
dhruv.patil@kalvium.community
abhinav.singh@kalvium.community
pranjal.gosavi@kalvium.community
atharva.kharade@kalvium.community
bhagirath.auti@kalvium.community
ayush.ghodke@kalvium.community
om.jadhav@kalvium.community
malpure.raj@kalvium.community
yash.bodhe@kalvium.community
vaishnavi.salunkhe@kalvium.community
divyam.desai@kalvium.community
rushikesh.zope@kalvium.community
kshitij.kotecha@kalvium.community
sahil.kharatmol@kalvium.community
isha.rode@kalvium.community
aditya.borhade@kalvium.community
parth.shah@kalvium.community
ayush.tiwari@kalvium.community
ayman.velani@kalvium.community
shreya.pawar@kalvium.community
chinmayee.harane@kalvium.community
joyce.ubale@kalvium.community
tushar.shekhar@kalvium.community
bhumika.raut@kalvium.community
dhruvil.sheth@kalvium.community
shriyans.jindal@kalvium.community
janhavi.hivarekar@kalvium.community
`;

const RVU = `
sajit.m@kalvium.community
adithi.m@kalvium.community
venkat.m@kalvium.community
anavi.k@kalvium.community
karthik.ram@kalvium.community
vidvath.j@kalvium.community
ishant.aryan@kalvium.community
likitha.ta@kalvium.community
akshat.m@kalvium.community
pawan.o@kalvium.community
prabhas.v@kalvium.community
piyush.b@kalvium.community
prithvi.k@kalvium.community
nanditha.k@kalvium.community
madan.p@kalvium.community
yashas.b@kalvium.community
drishan.g@kalvium.community
raniya.p@kalvium.community
suyog.g@kalvium.community
vinusha.m@kalvium.community
dhruv.kashyap@kalvium.community
bhouvana.v@kalvium.community
hemanth.m@kalvium.community
bindhushreeb@kalvium.community
daniel.s@kalvium.community
saiteja.b@kalvium.community
rajkumar.s@kalvium.community
prashanth.s@kalvium.community
yuvraj.j@kalvium.community
r.suhas@kalvium.community
sathwik.v@kalvium.community
vignesh.gr@kalvium.community
manaswini.n@kalvium.community
ashwanth.r@kalvium.community
`;

const APOLLO = `
harshith.a@kalvium.community
guna.priya@kalvium.community
srikeerthi.k@kalvium.community
saipavithra.g@kalvium.community
parandhama.b@kalvium.community
meghana.m@kalvium.community
rehman.sk@kalvium.community
ishana.k@kalvium.community
chumanilalasa.m@kalvium.community
`;

const VELS = `
kishore.d@kalvium.community
ram.r@kalvium.community
sudhan.s@kalvium.community
akhil.k@kalvium.community
aditya.udaykumar@kalvium.community
venkat.r@kalvium.community
ranjan.m@kalvium.community
karishma.ss@kalvium.community
shaswath.g@kalvium.community
jesudas.t@kalvium.community
harish.s@kalvium.community
jeeveeka.ps@kalvium.community
manuel.b@kalvium.community
premapriya.d@kalvium.community
prasanth.j@kalvium.community
mohammed.rafeeq@kalvium.community
jayavarsan.r@kalvium.community
adhithyaa.mv@kalvium.community
monesh.b@kalvium.community
`;

const YENEPOYA = `
kopperun.s@kalvium.community
jithumon.j@kalvium.community
abdulla.shahil@kalvium.community
shahabas.a@kalvium.community
abishek.naik@kalvium.community
pratham.d@kalvium.community
shahina@kalvium.community
samarth.s@kalvium.community
vivanraj.m@kalvium.community
musthafa.cp@kalvium.community
adithyan.p@kalvium.community
`;

/**
 * `[campusName, code-for-new-rows, block]`. `code` is only used when the campus does
 * not already exist (see `import-infosys-roster.ts::resolveCampus`) — an existing
 * campus keeps its existing code untouched.
 */
const BLOCKS: Array<[string, string, string]> = [
  ['Chitkara University', 'CHITKARA', CHITKARA],
  ['JECRC University', 'JECRC', JECRC],
  ['Kalasalingam Academy of Research and Education', 'KALASALINGAM', KALASALINGAM],
  ['Kalvium Direct', 'KALVIUMDIRECT', KALVIUM_DIRECT],
  ['Lovely Professional University', 'LPU', LPU],
  ['Manipal University Jaipur', 'MUJ', MUJ],
  ['MIT-ADT University', 'MITADT', MITADT],
  ['RV University', 'RVU', RVU],
  ['The Apollo University', 'APOLLO', APOLLO],
  ['Vels Institute of Science', 'VELS_INFOSYS_UNUSED', VELS],
  ['Yenepoya University', 'YENEPOYA', YENEPOYA],
];

export const INFOSYS_ROSTER: InfosysRosterRow[] = BLOCKS.flatMap(([campusName, , block]) =>
  block
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((email) => ({ email: email.toLowerCase(), campusName })),
);

/** Suggested `Campus.code` for a campus name, only consulted when creating a new row. */
export const SUGGESTED_CAMPUS_CODE: Record<string, string> = Object.fromEntries(
  BLOCKS.map(([campusName, code]) => [campusName, code]),
);

/** The expected per-campus counts from the source roster — checked by the import script
 * and by `infosys-roster-data.spec.ts` so a future edit to this file cannot silently
 * drop or duplicate a row without a test failing. */
export const EXPECTED_CAMPUS_COUNTS: Record<string, number> = {
  'Chitkara University': 10,
  'JECRC University': 18,
  'Kalasalingam Academy of Research and Education': 12,
  'Kalvium Direct': 21,
  'Lovely Professional University': 32,
  'Manipal University Jaipur': 9,
  'MIT-ADT University': 30,
  'RV University': 34,
  'The Apollo University': 9,
  'Vels Institute of Science': 19,
  'Yenepoya University': 11,
};

export const EXPECTED_TOTAL = 205;
