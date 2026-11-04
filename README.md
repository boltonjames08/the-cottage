# The Cottage

A cosy 2D roleplay space for D&D groups: walk around a cottage, sit at the table, and talk with proximity voice chat. The DM's browser runs the session; this small server links everyone's browsers together.

## Put it online for free (about 10 minutes)

You need two free accounts: **GitHub** (stores the files) and **Render** (runs the website). No coding, no installing.

### 1. Upload the files to GitHub
1. Go to https://github.com and sign up (free).
2. Click **+** (top right) → **New repository**.
   - Repository name: `the-cottage`
   - Choose **Public** or **Private** (either works).
   - Click **Create repository**.
3. On the next page click **uploading an existing file**.
4. Unzip `the-cottage-website.zip` on your computer. Open the unzipped `the-cottage` folder, select **everything inside it** (`server.js`, `package.json`, `render.yaml`, `README.md` and the `public` folder) and drag it all onto the GitHub page.
   - Check the list shows `public/index.html`. If the `public` folder didn't come across, drag the `public` folder on its own as well.
5. Click **Commit changes**.

### 2. Run it on Render
1. Go to https://render.com and click **Get Started**. Sign up **with GitHub** (easiest).
2. Click **New** → **Web Service**, then pick your `the-cottage` repository (allow Render to see it if asked).
3. Fill in:
   - **Name:** `the-cottage` (this becomes your web address)
   - **Language / Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** **Free**
4. Click **Deploy Web Service**. After a minute or two it says **Live**.
5. Your game is at the address shown at the top, for example **https://the-cottage.onrender.com**. (If that name is taken, Render adds a few letters to it.)

### 3. Play
- The DM opens the website, enters a name and clicks **Create session (as DM)**.
- Send your friends the website link and the 4-letter code. They open it on any computer, phone or tablet, enter the code and click **Join session**.
- Everyone clicks **Connect mic** and allows the microphone.
- The DM must keep their tab open: closing it ends the session for everyone.

## Good to know
- **First visit can be slow:** on the free plan the site goes to sleep after 15 minutes with nobody on it. The next visit wakes it up in about a minute; after that it's instant.
- **Changing the game later:** upload the new `public/index.html` to GitHub (same way as above, it replaces the old one). Render updates the site automatically.
- **Voice not connecting for someone:** voice goes straight between players' devices. A few home or mobile networks block that; if one person can't hear anyone, ask them to try another network (for example Wi-Fi instead of mobile data). If it keeps happening you can add a TURN relay service: put its details in a Render environment setting called `ICE_SERVERS`, as JSON, for example
  `[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:YOUR-TURN-SERVER:3478","username":"USER","credential":"PASSWORD"}]`
- **Run it on your own computer instead** (needs Node.js): open Command Prompt in this folder and run `node server.js`, then visit http://localhost:3000.
