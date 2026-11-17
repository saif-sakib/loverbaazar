#!/usr/bin/env python3
"""Print paths/counts only; never output matching credential values."""
import re,subprocess,sys
pattern=r'(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|xkeysib-[A-Za-z0-9-]{40,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----)'
paths=['.',':(exclude)apps/store/src/data',':(exclude)apps/api/seed',':(exclude)data/raw',':(exclude)*lock*']
revs=subprocess.check_output(['git','rev-list','--all'],text=True).splitlines() if '--history' in sys.argv else ['HEAD']
failures=set()
for rev in revs:
 r=subprocess.run(['git','grep','-I','-l','-E',pattern,rev,'--',*paths],capture_output=True,text=True)
 if r.returncode not in (0,1):raise SystemExit('Could not scan repository')
 for line in r.stdout.splitlines():failures.add(line.split(':',1)[-1])
files=subprocess.check_output(['git','ls-files'],text=True).splitlines()
for f in files:
 if re.search(r'(^|/)(\.env($|\.(?!example$))|data/raw/)|\.(dump|sql\.gz|dump\.gpg)$',f):failures.add(f)
print(f'Scanned {len(revs)} revisions; {len(failures)} potential credential/private-export paths.')
for f in sorted(failures):print(f)
raise SystemExit(bool(failures))
