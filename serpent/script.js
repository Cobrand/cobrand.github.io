let SOUNDS = {
    shield_off: new Audio('se_common_guardoff.wav'),
    shield_on: new Audio('se_common_guardon.wav'),
    shield_block: new Audio('se_common_shieldguard.wav'),
    nade_pull: new Audio('se_snake_special_N01.wav'),
    nade_explode: new Audio('se_snake_special_N04.wav'),
    ike_dmg_1: new Audio('vc_ike_damage01.wav'),
    ike_dmg_2: new Audio('vc_ike_damage02.wav'),
};

SOUNDS.shield_off.volume = 0.3;
SOUNDS.shield_on.volume = 0.3;
SOUNDS.shield_block.volume = 0.3;

SOUNDS.nade_pull.volume = 0.15;
SOUNDS.nade_explode.volume = 0.15;

SOUNDS.ike_dmg_1.volume = 0.3;
SOUNDS.ike_dmg_2.volume = 0.3;

let nades_score = {
    total: 0,
    success: 0,
}

let frames = {
    shield: 0,
    raw: 0,
};

let timeout_handler = undefined;
let nades_in_play = 0;

let is_currently_shielding = false;

let grenade_mean_delay = 3500;

function play_sound(sound) {
    if (sound.paused) {
        sound.play()
    } else {
        sound.currentTime = 0;
    }

}

function change_difficulty(e) {
    grenade_mean_delay = parseInt(e.target.value) || 3500;
}

function grenade_pull() {
    if (nades_in_play >= 2) {
        return;
    }
    nades_in_play += 1;
    play_sound(SOUNDS.nade_pull);
    setTimeout(grenade_explode, 2500);
}

function success() {
    nades_score.success += 1;
    setTimeout(() => play_sound(SOUNDS.shield_block), 100);
    let class_list = document.getElementById('main').classList;
    class_list.add('success');
    class_list.remove('toast');
}

function toast() {
    if (Math.random() > 0.5 ) {
        setTimeout(() => play_sound(SOUNDS.ike_dmg_1), 150);
    } else {
        setTimeout(() => play_sound(SOUNDS.ike_dmg_2), 150);
    }
    let class_list = document.getElementById('main').classList;
    class_list.remove('success');
    class_list.add('toast');
}

function grenade_explode() {
    nades_in_play -= 1;
    play_sound(SOUNDS.nade_explode)
    nades_score.total += 1;
    if (is_currently_shielding) {
        success();
    } else {
        toast();
    }
}

function start_stop() {
    if (timeout_handler == undefined) {
        timeout_handler = setTimeout(random_nade, 1500);
        document.getElementById('start_btn').innerText = 'Stop';
    } else {
        clearTimeout(timeout_handler);
        timeout_handler = undefined;
        document.getElementById('start_btn').innerText = 'Start';
    }
}

function random_nade() {
    grenade_pull();
    let next_nade_timeout = 500 + Math.random() * grenade_mean_delay * 2;
    timeout_handler = setTimeout(random_nade, next_nade_timeout);
}

function start_shield() {
    play_sound(SOUNDS.shield_on)
    is_currently_shielding = true;
}

function stop_shield() {
    play_sound(SOUNDS.shield_off)
    is_currently_shielding = false;
}

function refresh() {
    if (nades_in_play > 0) {
        if (is_currently_shielding) {
            frames.shield += 1;
        } else {
            frames.raw += 1;
        }
    }
    let shield_rate = (100 * frames.shield / (frames.raw + frames.shield));
    if (isNaN(shield_rate)) {
        shield_rate = 0;
    }
    document.getElementById('shield_rate').innerText = shield_rate.toFixed(1);
    let success_rate = (100 * nades_score.success / nades_score.total);
    if (isNaN(success_rate)) {
        success_rate = 0;
    }
    document.getElementById('success_rate').innerText = success_rate.toFixed(1);
    document.getElementById('score').innerText = nades_score.success;
    document.getElementById('total').innerText = nades_score.total;
}
setInterval(refresh, 50);

document.addEventListener('keydown', (ev) => {
    if (!ev.repeat && ev.key == 's') {
        start_shield();
    }
});

document.addEventListener('keyup', (ev) => {
    if (ev.key == 's') {
        stop_shield();
    }
})

document.getElementById('difficulty').onchange = change_difficulty;