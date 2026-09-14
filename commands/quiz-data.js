'use strict';

const QUIZ_DATA = {
  naruto: [
    { q: "Who is Naruto Uzumaki's father?", choices: ["A. Jiraiya", "B. Minato Namikaze", "C. Kakashi Hatake", "D. Itachi Uchiha"], answer: "B", xp: 10, category: "naruto" },
    { q: "Which tailed beast is sealed inside Naruto?", choices: ["A. Sanbi (3 tails)", "B. Gobi (5 tails)", "C. Kyubi (9 tails)", "D. Nanabi (7 tails)"], answer: "C", xp: 10, category: "naruto" },
    { q: "What is Naruto's signature technique?", choices: ["A. Chidori", "B. Susanoo", "C. Rasengan", "D. Amaterasu"], answer: "C", xp: 10, category: "naruto" },
    { q: "Who killed Itachi Uchiha?", choices: ["A. Naruto", "B. Sasuke", "C. Madara", "D. Obito"], answer: "B", xp: 15, category: "naruto" },
    { q: "Which village is Naruto from?", choices: ["A. Sunagakure", "B. Kirigakure", "C. Iwagakure", "D. Konohagakure"], answer: "D", xp: 10, category: "naruto" },
    { q: "What is the true name of Tobi?", choices: ["A. Madara Uchiha", "B. Obito Uchiha", "C. Black Zetsu", "D. Izuna Uchiha"], answer: "B", xp: 20, category: "naruto" },
    { q: "How many tomoe does a complete Sharingan have?", choices: ["A. 1", "B. 2", "C. 3", "D. 4"], answer: "C", xp: 10, category: "naruto" },
    { q: "What is the Hyuga clan's kekkei genkai?", choices: ["A. Sharingan", "B. Byakugan", "C. Rinnegan", "D. Jougan"], answer: "B", xp: 10, category: "naruto" },
    { q: "Who is the sixth Hokage?", choices: ["A. Naruto", "B. Tsunade", "C. Kakashi", "D. Gaara"], answer: "C", xp: 15, category: "naruto" },
    { q: "What is Kiba's companion animal?", choices: ["A. Kakashi-chan", "B. Akamaru", "C. Pakkun", "D. Gamabunta"], answer: "B", xp: 10, category: "naruto" },
  ],
  onepiece: [
    { q: "What is Luffy's Devil Fruit?", choices: ["A. Mera Mera no Mi", "B. Gomu Gomu no Mi", "C. Hie Hie no Mi", "D. Gura Gura no Mi"], answer: "B", xp: 10, category: "onepiece" },
    { q: "Who is the cook of the Straw Hat crew?", choices: ["A. Zoro", "B. Usopp", "C. Sanji", "D. Franky"], answer: "C", xp: 10, category: "onepiece" },
    { q: "What is Roronoa Zoro's dream?", choices: ["A. Find the One Piece", "B. Become Grand Chef", "C. Become the greatest swordsman", "D. Find his family"], answer: "C", xp: 10, category: "onepiece" },
    { q: "What is the current ship of the Straw Hats?", choices: ["A. Going Merry", "B. Moby Dick", "C. Thousand Sunny", "D. Polar Tang"], answer: "C", xp: 10, category: "onepiece" },
    { q: "Who is 'Hawk-Eye'?", choices: ["A. Shanks", "B. Crocodile", "C. Dracule Mihawk", "D. Doflamingo"], answer: "C", xp: 15, category: "onepiece" },
    { q: "Who ate the Yami Yami no Mi?", choices: ["A. Akainu", "B. Marshall D. Teach", "C. Aokiji", "D. Kizaru"], answer: "B", xp: 15, category: "onepiece" },
    { q: "What is the true fruit of Luffy after revelation?", choices: ["A. Gomu Gomu no Mi", "B. Hito Hito no Mi: Model Nika", "C. Gura Gura no Mi", "D. Magu Magu no Mi"], answer: "B", xp: 25, category: "onepiece", hard: true },
    { q: "How many swords does Zoro use?", choices: ["A. 1", "B. 2", "C. 3", "D. 4"], answer: "C", xp: 10, category: "onepiece" },
  ],
  dragonball: [
    { q: "What is Goku's race?", choices: ["A. Human", "B. Namek", "C. Saiyan", "D. Android"], answer: "C", xp: 10, category: "dragonball" },
    { q: "How many Dragon Balls exist?", choices: ["A. 5", "B. 6", "C. 7", "D. 9"], answer: "C", xp: 10, category: "dragonball" },
    { q: "Who is Goku's biological father?", choices: ["A. Vegeta (the king)", "B. Bardock", "C. Raditz", "D. Nappa"], answer: "B", xp: 15, category: "dragonball" },
    { q: "Who created Androids 17 and 18?", choices: ["A. Gero", "B. Bulma", "C. Freeza", "D. Cell"], answer: "A", xp: 15, category: "dragonball" },
    { q: "What is Goku's ultimate form in DBS?", choices: ["A. Super Saiyan Blue", "B. Ultra Instinct Sign", "C. Ultra Instinct", "D. Mastered Ultra Instinct"], answer: "D", xp: 20, category: "dragonball", hard: true },
    { q: "How many sons does Goku have?", choices: ["A. 1", "B. 2", "C. 3", "D. 4"], answer: "B", xp: 10, category: "dragonball" },
    { q: "What is Goku's wife's name?", choices: ["A. Bulma", "B. Chi-Chi", "C. Launch", "D. Android 18"], answer: "B", xp: 10, category: "dragonball" },
  ],
  aot: [
    { q: "Who carries the Attack Titan?", choices: ["A. Armin", "B. Levi", "C. Eren Yeager", "D. Zeke"], answer: "C", xp: 10, category: "aot" },
    { q: "What military corps fights Titans outside the walls?", choices: ["A. Military Police", "B. Survey Corps", "C. Garrison", "D. Royal Guard"], answer: "B", xp: 10, category: "aot" },
    { q: "Who had the Colossal Titan before Armin?", choices: ["A. Reiner", "B. Annie", "C. Bertholdt", "D. Zeke"], answer: "C", xp: 15, category: "aot" },
    { q: "What are the three main walls (outermost to innermost)?", choices: ["A. Wall Maria, Wall Rose, Wall Sina", "B. Wall Alpha, Wall Beta, Wall Gamma", "C. Wall North, Wall South, Wall Center", "D. Wall Ymir, Wall Historia, Wall Christa"], answer: "A", xp: 15, category: "aot" },
    { q: "What is 'The Rumbling'?", choices: ["A. Sound of titans walking", "B. Wall titans destroying the world", "C. Eren's roar", "D. The sea's rumble"], answer: "B", xp: 25, category: "aot", hard: true },
    { q: "Who is Eren's father?", choices: ["A. Keith Shadis", "B. Grisha Yeager", "C. Rod Reiss", "D. Zeke Yeager"], answer: "B", xp: 10, category: "aot" },
    { q: "What country are warriors like Reiner from?", choices: ["A. Paradis", "B. Hizuru", "C. Marley", "D. Eldia"], answer: "C", xp: 15, category: "aot" },
  ],
  demonslayer: [
    { q: "What is Tanjiro's main breathing technique?", choices: ["A. Thunder Breathing", "B. Fire Breathing", "C. Water Breathing", "D. Wind Breathing"], answer: "C", xp: 10, category: "demonslayer" },
    { q: "Who is the master of the Demon Slayer Corps?", choices: ["A. Rengoku", "B. Kagaya Ubuyashiki", "C. Giyu Tomioka", "D. Shinobu Kocho"], answer: "B", xp: 15, category: "demonslayer" },
    { q: "Who is the Demon King?", choices: ["A. Akaza", "B. Doma", "C. Kokushibo", "D. Muzan Kibutsuji"], answer: "D", xp: 10, category: "demonslayer" },
    { q: "What is special about Nezuko as a demon?", choices: ["A. She can speak", "B. She doesn't need human blood", "C. She is immortal", "D. She can fly"], answer: "B", xp: 15, category: "demonslayer" },
    { q: "What breathing form is the origin of all others?", choices: ["A. Sun Breathing", "B. Water Breathing", "C. Moon Breathing", "D. Thunder Breathing"], answer: "A", xp: 20, category: "demonslayer", hard: true },
  ],
  mha: [
    { q: "What is Izuku Midoriya's Quirk?", choices: ["A. All for One", "B. One for All", "C. Zero Gravity", "D. Explosion"], answer: "B", xp: 10, category: "mha" },
    { q: "What class is Deku in at UA?", choices: ["A. Class 1-B", "B. Class 2-A", "C. Class 1-A", "D. Support Department"], answer: "C", xp: 10, category: "mha" },
    { q: "What is Bakugo's Quirk?", choices: ["A. One for All", "B. Hardening", "C. Explosion", "D. High Speed"], answer: "C", xp: 10, category: "mha" },
    { q: "What is Dabi's real name?", choices: ["A. Keigo Takami", "B. Touya Todoroki", "C. Kai Chisaki", "D. Shuichi Iguchi"], answer: "B", xp: 20, category: "mha", hard: true },
    { q: "Who is the number 1 hero after All Might?", choices: ["A. Hawks", "B. Best Jeanist", "C. Endeavor", "D. Mirko"], answer: "C", xp: 10, category: "mha" },
  ],
  general: [
    { q: "In which anime do we find the 'Death Note'?", choices: ["A. Bleach", "B. Death Note", "C. Hunter x Hunter", "D. Fullmetal Alchemist"], answer: "B", xp: 10, category: "general" },
    { q: "Who is the strongest man in One Punch Man?", choices: ["A. Genos", "B. Tatsumaki", "C. Bang", "D. Saitama"], answer: "D", xp: 10, category: "general" },
    { q: "Which studio produced 'Spirited Away'?", choices: ["A. Toei Animation", "B. Madhouse", "C. Studio Ghibli", "D. Bones"], answer: "C", xp: 10, category: "general" },
    { q: "What is an 'isekai'?", choices: ["A. An action manga", "B. A sports anime", "C. A genre where the character is transported to another world", "D. A romantic anime"], answer: "C", xp: 10, category: "general" },
    { q: "Who writes the manga 'One Piece'?", choices: ["A. Masashi Kishimoto", "B. Akira Toriyama", "C. Eiichiro Oda", "D. Tite Kubo"], answer: "C", xp: 10, category: "general" },
    { q: "What is the first anime in history?", choices: ["A. Astro Boy", "B. Doraemon", "C. Sazae-san", "D. Dragon Ball"], answer: "A", xp: 20, category: "general", hard: true },
    { q: "What does 'Senpai' mean?", choices: ["A. Master/Teacher", "B. Junior", "C. A more experienced/senior person", "D. Enemy"], answer: "C", xp: 10, category: "general" },
  ],
};

function getQuestions(category, difficulty, count) {
  category = category || 'random';
  difficulty = difficulty || 'easy';
  count = count || 5;
  let pool = [];

  if (category === 'random' || category === 'anime') {
    const allCats = Object.values(QUIZ_DATA).flat();
    pool = difficulty === 'hard' ? allCats.filter(q => q.hard) : allCats.filter(q => !q.hard);
  } else if (QUIZ_DATA[category]) {
    pool = difficulty === 'hard' ? QUIZ_DATA[category].filter(q => q.hard) : QUIZ_DATA[category];
    if (pool.length === 0) pool = QUIZ_DATA[category];
  } else {
    pool = Object.values(QUIZ_DATA).flat();
  }

  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

module.exports = { QUIZ_DATA, getQuestions };
